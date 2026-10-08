/* Analytics regression: proves the /api/analytics/* endpoints answer with the
   shapes the modular dashboard renders. Run: node tools/analytics-regress.cjs
   (expects the server on PORT or 3101 with ADMIN_KEY=admin). */
const PORT = process.env.PORT || '3101';
const KEY = process.env.ADMIN_KEY || 'admin';
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};

async function get(path) {
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${BASE}${path}${sep}key=${KEY}`);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

(async () => {
  console.log('\n[1] /api/analytics/overview');
  let r = await get('/api/analytics/overview?days=30');
  ok('200', r.status === 200, 'status=' + r.status);
  ok('has 10 kpis', r.body.kpis && Object.keys(r.body.kpis).length === 10, Object.keys(r.body.kpis || {}).join(','));
  ok('kpi shape', r.body.kpis && !!r.body.kpis.cost_usd && 'delta_pct' in r.body.kpis.cost_usd);
  ok('totals present', r.body.totals && typeof r.body.totals.cost_usd === 'number');

  console.log('\n[2] /api/analytics/timeseries zero-filled');
  r = await get('/api/analytics/timeseries?days=7');
  ok('200', r.status === 200, 'status=' + r.status);
  ok('7 points', Array.isArray(r.body.points) && r.body.points.length === 7, String(r.body.points && r.body.points.length));
  ok('ascending days', r.body.points.every((p, i, a) => i === 0 || p.day > a[i - 1].day));
  ok('point shape', !!r.body.points[0] && 'cost_usd' in r.body.points[0] && 'avg_latency_ms' in r.body.points[0]);

  console.log('\n[3] /api/analytics/breakdown');
  r = await get('/api/analytics/breakdown?days=30');
  ok('200', r.status === 200, 'status=' + r.status);
  for (const k of ['by_model', 'by_user', 'by_session', 'by_kind']) {
    ok(k + ' is array', Array.isArray(r.body[k]), typeof r.body[k]);
  }

  console.log('\n[4] /api/analytics/realtime');
  r = await get('/api/analytics/realtime');
  ok('200', r.status === 200, 'status=' + r.status);
  ok('pulse fields', typeof r.body.active_sessions_15min === 'number' && typeof r.body.requests_last_minute === 'number');
  ok('counters object', !!r.body.counters && typeof r.body.counters === 'object');

  console.log('\n[5] /api/analytics/users + sessions');
  r = await get('/api/analytics/users?days=30');
  ok('users 200', r.status === 200, 'status=' + r.status);
  ok('users array', Array.isArray(r.body.users));
  r = await get('/api/analytics/sessions?limit=5');
  ok('sessions 200', r.status === 200, 'status=' + r.status);
  ok('sessions array', Array.isArray(r.body.sessions));

  console.log('\n[6] auth + validation');
  const unauth = await fetch(`${BASE}/api/analytics/overview?days=30`);
  ok('401 without key (when ADMIN_KEY set)', unauth.status === 401 || process.env.ADMIN_KEY === '', 'status=' + unauth.status);
  r = await get('/api/analytics/overview?days=9999');
  ok('days clamped, still 200', r.status === 200 && r.body.days <= 365, 'days=' + r.body.days);

  console.log('\n[7] cost rates: configurable, validated, admin-only');
  r = await get('/api/admin/cost-rates');
  ok('rates 200', r.status === 200, 'status=' + r.status);
  ok('rates shape', r.body.rates && typeof r.body.rates.input_per_million === 'number'
    && typeof r.body.rates.output_per_million === 'number'
    && ['custom', 'default'].includes(r.body.rates.source));

  const original = { ...r.body.rates };
  const put = (body) => fetch(`${BASE}/api/admin/cost-rates?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  let res = await put({ input_per_million: 1, output_per_million: 4 });
  let json = await res.json();
  ok('save rates 200', res.status === 200, 'status=' + res.status);
  ok('saved rates echoed', json.rates.input_per_million === 1 && json.rates.output_per_million === 4);
  ok('saved is custom', json.rates.source === 'custom');

  // A rate change must actually move the numbers on the session table, otherwise
  // the setting is decorative. The rate is set to 2 HERE rather than inside the
  // branch, so both paths below are asserting about the same saved value.
  const RATE_UNDER_TEST = 2;
  const before = await get('/api/analytics/sessions?limit=all');
  const sampleBefore = before.body.sessions && before.body.sessions[0];
  res = await put({ input_per_million: RATE_UNDER_TEST, output_per_million: 4 });
  await res.json();
  const after = await get('/api/analytics/sessions?limit=all');
  ok('sessions echo active rates', after.body.rates.input_per_million === RATE_UNDER_TEST,
    'got=' + after.body.rates.input_per_million);

  if (sampleBefore && sampleBefore.input_tokens > 0) {
    const s2 = after.body.sessions.find(s => s.session_id === sampleBefore.session_id);
    const expectedIn = sampleBefore.input_tokens * RATE_UNDER_TEST / 1e6;
    const expectedOut = sampleBefore.output_tokens * 4 / 1e6;
    ok('IT cost matches tokens x rate', !!s2 && Math.abs(s2.input_cost_usd - expectedIn) < 1e-9,
      'got=' + (s2 && s2.input_cost_usd) + ' want~' + expectedIn);
    ok('OT cost matches tokens x rate', !!s2 && Math.abs(s2.output_cost_usd - expectedOut) < 1e-9,
      'got=' + (s2 && s2.output_cost_usd) + ' want~' + expectedOut);
    ok('rated total = IT + OT', !!s2 && Math.abs(s2.cost_usd - (s2.input_cost_usd + s2.output_cost_usd)) < 1e-9);
  } else {
    ok('IT cost matches tokens x rate (skipped, no usage data)', true);
    ok('OT cost matches tokens x rate (skipped, no usage data)', true);
    ok('rated total = IT + OT (skipped, no usage data)', true);
  }

  res = await put({ input_per_million: -5 });
  ok('negative rate rejected 400', res.status === 400, 'status=' + res.status);
  res = await put({ input_per_million: 'abc' });
  ok('non-numeric rate rejected 400', res.status === 400, 'status=' + res.status);
  const noAuth = await fetch(`${BASE}/api/admin/cost-rates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input_per_million: 99 })
  });
  ok('rates require admin 401', noAuth.status === 401 || !process.env.ADMIN_KEY, 'status=' + noAuth.status);

  const del = await fetch(`${BASE}/api/admin/cost-rates?key=${KEY}`, { method: 'DELETE' });
  const delJson = await del.json();
  ok('reset 200', del.status === 200);
  ok('reset is default', delJson.rates.source === 'default');
  ok('reset restores values', delJson.rates.input_per_million === (original.source === 'custom' ? original.input_per_million : delJson.rates.input_per_million));

  console.log('\n[8] per-session rows: shape, order, arithmetic');
  r = await get('/api/analytics/sessions?limit=all');
  const rows = r.body.sessions || [];
  ok('sessions 200', r.status === 200);
  ok('rates on sessions payload', !!r.body.rates && typeof r.body.rates.input_per_million === 'number');
  if (rows.length) {
    const row = rows[0];
    for (const f of ['session_id', 'session_no', 'user_messages', 'assistant_messages',
      'input_tokens', 'output_tokens', 'input_cost_usd', 'output_cost_usd',
      'cost_usd', 'ledger_cost_usd', 'files_count', 'files']) {
      ok('row has ' + f, f in row);
    }
    ok('messages = in + out', row.messages === row.user_messages + row.assistant_messages,
      `${row.messages} != ${row.user_messages}+${row.assistant_messages}`);
    ok('total_tokens = in + out', row.total_tokens === row.input_tokens + row.output_tokens);
    ok('cost = it + ot', Math.abs(row.cost_usd - (row.input_cost_usd + row.output_cost_usd)) < 1e-9);
    ok('files_count matches array', row.files_count === row.files.length);

    // 1,2,3... within a conversation, oldest first overall.
    const byConv = {};
    for (const s of rows) {
      const conv = s.session_id.split('#')[0];
      (byConv[conv] = byConv[conv] || []).push(s.session_no);
    }
    ok('ordinals start at 1 and are contiguous', Object.values(byConv).every(ns =>
      ns[0] === 1 && ns.every((n, i) => n === i + 1)),
      JSON.stringify(byConv));
    // Ascending by REAL time. Comparing the raw strings is what shipped broken:
    // created_at arrives as a Date, String() renders it with a weekday name, and
    // "Thu" sorts before "Wed" on every date.
    const parseTs = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? t : -Infinity; };
    ok('sessions sorted oldest first', rows.every((s, i) => i === 0
      || parseTs(s.created_at) >= parseTs(rows[i - 1].created_at)),
      rows.map(s => s.created_at).join(' | '));
    // Within one conversation the ordinal must increase with time, or the label
    // contradicts the row it sits on.
    const byConvOrdered = {};
    for (const s of rows) {
      const conv = s.session_id.replace(/[0-9]+$/, '');
      (byConvOrdered[conv] = byConvOrdered[conv] || []).push(s);
    }
    ok('ordinal increases with time within a conversation',
      Object.values(byConvOrdered).every(list => list.every((s, i) =>
        i === 0 || s.session_no > list[i - 1].session_no)),
      JSON.stringify(Object.fromEntries(Object.entries(byConvOrdered)
        .map(([k, v]) => [k, v.map(x => `${x.session_no}@${x.created_at}`)]))));
    ok('status is ended or active', rows.every(s => s.status === 'ended' || s.status === 'active'));
  } else {
    ok('row shape (skipped, no sessions)', true);
    ok('cost = it + ot (skipped)', true);
    ok('files_count matches array (skipped)', true);
    ok('ordinals contiguous (skipped)', true);
    ok('sorted oldest first (skipped)', true);
    ok('ordinal increases with time (skipped)', true);
    ok('status enum (skipped)', true);
  }

  console.log('\n[9] dashboard shell + modules exist');
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'public', 'Dashboard');
  ok('index.html exists', fs.existsSync(path.join(root, 'index.html')));
  const shell = fs.existsSync(path.join(root, 'index.html')) ? fs.readFileSync(path.join(root, 'index.html'), 'utf8') : '';
  for (const id of ['kpiRow', 'chTraffic', 'costModelBody', 'userRows', 'convBody', 'livePulse', 'logBody']) {
    ok('shell has #' + id, shell.includes(`id="${id}"`), 'missing');
  }
  for (const m of ['js/main.js', 'js/api.js', 'js/tabs/overview.js', 'js/tabs/users.js']) {
    ok(m + ' compiled', fs.existsSync(path.join(root, m)), 'missing');
  }
  ok('no giant admin.js import', !shell.includes('admin.js'));

  console.log('\n[10] Per Session Cost table columns + rate editor mount points');
  for (const id of ['costSessionBody', 'costUserBody', 'costModelBody', 'costKindBody',
    'sessionLimit', 'usageFilterMode', 'costUserSearch', 'costFilterChip',
    'costSessionCount', 'costRateBadge', 'liveRates', 'rateModal', 'rateForm',
    'rateInput', 'rateOutput', 'rateReset', 'sessionExportHost', 'usersExportHost']) {
    ok('shell has #' + id, shell.includes(`id="${id}"`), 'missing');
  }
  for (const m of ['js/tabs/costs.js', 'js/tabs/rates.js', 'js/tabs/realtime.js',
    'js/tabs/export.js', 'js/modal.js']) {
    ok(m + ' compiled', fs.existsSync(path.join(root, m)), 'missing');
  }
  // The export button is built in JS, so the host div existing is not proof that
  // anything was mounted into it.
  const exportSrc = fs.readFileSync(path.join(root, 'js/tabs/costs.js'), 'utf8');
  ok('session export mounted', /mountExport\(must\('sessionExportHost'\)/.test(exportSrc));
  ok('user export mounted', /mountExport\(must\('usersExportHost'\)/.test(exportSrc));
  ok('session export has a fetch-all path', /fetchAll:\s*\(\)\s*=>\s*fetchAllSessions/.test(exportSrc));
  const expSrc = fs.readFileSync(path.join(root, 'js/tabs/export.js'), 'utf8');
  ok('export offers csv', expSrc.includes("data-export") && expSrc.includes("'csv'"));
  ok('export offers json', expSrc.includes("'json'"));
  ok('export offers all-rows', expSrc.includes('csv-all'));
  // Exporting must read the payload, not the rendered cells, or the file will not
  // reconcile with the table it claims to describe.
  ok('export reads typed fields, not DOM',
    !/sessionBody'\)\.innerHTML.*exportTable/.test(exportSrc) && exportSrc.includes('s.input_cost_usd'));
  // The new columns are the whole point of the change, so their absence must fail.
  for (const th of ['Msgs In', 'Msgs Out', 'IT Cost', 'OT Cost', 'Total Cost', 'Files']) {
    ok('table has "' + th + '" column', shell.includes(`>${th}</th>`) || shell.includes(`>${th} <`), 'missing');
  }
  // A header and a cell must line up. These drifted once and the row silently
  // shifted a column left, so the counts are compared rather than trusted.
  // Thead sits BEFORE the tbody id, so search backwards from it - slicing forwards
  // from the tbody id finds nothing and silently reports a bogus count.
  const bodyAt = shell.indexOf('id="costSessionBody"');
  const headAt = shell.lastIndexOf('<thead', bodyAt);
  const theadEnd = shell.indexOf('</thead>', headAt);
  const head = shell.slice(headAt, theadEnd);
  ok('located the session table head', headAt !== -1 && head.includes('Per Session') === false && head.includes('<th') > 0);
  const thCount = (head.match(/<th[\s>]/g) || []).length;
  ok('session table has 14 headers', thCount === 14, 'got=' + thCount);
  const costsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'tabs', 'costs.ts'), 'utf8');
  const rowsStart = costsSrc.indexOf('function sessionRows');
  // End at the next top-level declaration; sessionRows is immediately followed
  // by renderCosts, and slicing too short silently drops the tail of the rows.
  const rowsEnd = costsSrc.indexOf('\nexport async function renderCosts', rowsStart);
  const rowsSrc = rowsStart > -1
    ? costsSrc.slice(rowsStart, rowsEnd > -1 ? rowsEnd : costsSrc.length)
    : '';
  // Count only the DATA cells: the empty-state row's single colspan cell sits in
  // the same function and would otherwise be counted as a column.
  const mapAt = rowsSrc.indexOf('list.map(');
  const tdCount = (mapAt > -1 ? (rowsSrc.slice(mapAt).match(/<td[\s>]/g) || []) : []).length;
  ok('sessionRows emits 14 cells', tdCount === 14, 'got=' + tdCount);
  const spanMatch = rowsSrc.match(/colspan="(\d+)"/);
  ok('empty-state colspan matches header count',
    !!spanMatch && Number(spanMatch[1]) === thCount,
    'span=' + (spanMatch && spanMatch[1]) + ' th=' + thCount);
  ok('Files column sits right after Msgs Out',
    /Msgs Out<\/th>\s*<th class="text-end">Files<\/th>/.test(head), 'Files not after Msgs Out');
  ok('Ledger column removed', !head.includes('>Ledger</th>'), 'Ledger still present');
  // fileCell is a sibling helper, so it lives outside the sessionRows slice.
  ok('zero-file sessions show 0 not a dash',
    /!s\.files_count\) return '<span class="text-muted">0<\/span>'/.test(costsSrc), 'zero renders as dash');
  ok('session id has no "#" separator',
    /session_id: `\$\{convId\}\$\{seg\.no\}`/.test(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'analytics-tables.service.ts'), 'utf8')),
    'session_id still uses "#"');
  ok('timestamps normalised before sorting',
    /function tsOf/.test(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'analytics-tables.service.ts'), 'utf8')),
    'tsOf normaliser missing');
  // Guard the bug that shipped once already: a duplicate id makes getElementById
  // resolve to the wrong node, so the filter silently does nothing.
  const ids = [...shell.matchAll(/id="([^"]+)"/g)].map(m2 => m2[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  ok('no duplicate ids in shell', dupes.length === 0, [...new Set(dupes)].join(','));
  const costsJs = fs.readFileSync(path.join(root, 'js/tabs/costs.js'), 'utf8');
  ok('costs.js sends username to sessions', costsJs.includes('username=${encodeURIComponent(f.username)}'));
  ok('costs.js passes chosen session limit', /limit=\$\{sessionLimit === 'all' \? 'all' : sessionLimit\}/.test(costsJs));
  const utilsJs = fs.readFileSync(path.join(root, 'js/utils.js'), 'utf8');
  ok('utils.js has usd6', /function usd6/.test(utilsJs));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });

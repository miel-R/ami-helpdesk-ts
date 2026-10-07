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

  console.log('\n[7] dashboard shell + modules exist');
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });

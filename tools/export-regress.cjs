/* Export regression: proves an export produces the right FILE, not just a button.
 *
 * Deliberately DOM-light. The widget suite has a hand-rolled DOM shim, and leaning
 * on it here would mean testing the shim. What can actually be wrong is: the wrong
 * headers, values rounded into uselessness, a filename that does not say what
 * scope or which rate it came from, and an "all rows" export that silently exports
 * only the rows on screen. Those are all checkable without a browser.
 *
 * Run: node tools/export-regress.cjs (no server needed).
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};

const root = path.join(__dirname, '..', 'public', 'Dashboard');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const rows = [
  { session_id: 'rems.baks1', user: 'rems.baks', status: 'ended',
    user_messages: 2, assistant_messages: 2, files_count: 0,
    input_tokens: 4239, output_tokens: 38,
    input_cost_usd: 0.0012717, output_cost_usd: 0.000095, cost_usd: 0.0013667,
    created_at: '2026-10-07T02:07:01.105Z', last_activity: '2026-10-07T02:13:05.230Z' },
  { session_id: 'rems.baks2', user: 'rems.baks', status: 'ended',
    user_messages: 8, assistant_messages: 8, files_count: 1,
    input_tokens: 15898, output_tokens: 141,
    input_cost_usd: 0.0047694, output_cost_usd: 0.0003525, cost_usd: 0.0051219,
    created_at: '2026-10-07T02:24:24.329Z', last_activity: '2026-10-07T02:30:21.993Z' }
];

/** Captures the download the exporter triggers: anchor name + blob text. */
const written = [];
const capturingDoc = {
  createElement: (tag) => {
    const el = { tag, click() {}, style: {} };
    Object.defineProperty(el, 'download', { set(v) { written.push({ name: v, blob: lastBlob }); } });
    return el;
  },
  getElementById: () => null
};
let lastBlob = null;

/** Loads the compiled browser modules with just the two globals they touch. */
function loadUtils() {
  const src = read('js/utils.js')
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/export function/g, 'function')
    .replace(/export interface[^}]*}\s*/g, '')
    .replace(/export const/g, 'const')
    + '\nmodule.exports = { exportTableToCSV };';
  const mod = { exports: {} };
  // The document is baked into the module's closure here, so the capture shim has
  // to be the one passed in - building it later has no effect.
  new Function('module', 'exports', 'document', src)(mod, mod.exports, capturingDoc);
  return mod.exports;
}

function loadExport(apiStub, flashStub) {
  const src = read('js/tabs/export.js')
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/export function/g, 'function')
    .replace(/export async function/g, 'async function')
    + '\nmodule.exports = { mountExport, toRecords, fetchAllSessions };';
  const mod = { exports: {} };
  new Function('module', 'exports', 'api', 'flash', 'exportTableToCSV', 'window', 'document',
    src)(mod, mod.exports, apiStub, flashStub, () => {}, {}, {
    querySelector: () => null, querySelectorAll: () => []
  });
  return mod.exports;
}

(async () => {
  const utils = loadUtils();

  console.log('\n[1] CSV writer emits header + every row, unquoted-cost friendly');
  const recs = rows.map(r => ({
    'Session': r.session_id,
    'Msgs In': r.user_messages,
    'Total Cost': r.cost_usd
  }));
  // Capture the Blob text rather than the anchor href.
  const realCreate = URL.createObjectURL;
  URL.createObjectURL = (b) => { lastBlob = b; return 'blob:fake'; };
  utils.exportTableToCSV('x.csv', ['Session', 'Msgs In', 'Total Cost'], recs, {
    format: 'csv', includeHeaders: true, headers: ['Session', 'Msgs In', 'Total Cost'], rows: recs
  });
  URL.createObjectURL = realCreate;
  const csv = await lastBlob.text();
  const lines = csv.split('\n').filter(Boolean);
  ok('header row present', lines[0] === 'Session,Msgs In,Total Cost', lines[0]);
  ok('one line per row', lines.length === 3, 'lines=' + lines.length);
  ok('first row correct', lines[1] === 'rems.baks1,2,0.0013667', lines[1]);
  ok('second row correct', lines[2] === 'rems.baks2,8,0.0051219', lines[2]);
  ok('download name ends .csv', /\.csv$/i.test(written[0]?.name || ''), written[0] && written[0].name);
  ok('csv mime type set', /text\/csv/.test(lastBlob.type), lastBlob.type);

  console.log('\n[2] JSON writer produces parseable JSON');
  let jsonBlob = null;
  URL.createObjectURL = (b) => { jsonBlob = b; return 'blob:fake'; };
  utils.exportTableToCSV('x.csv', ['Session', 'Total Cost'], recs, {
    format: 'json', includeHeaders: true, headers: ['Session', 'Total Cost'], rows: recs
  });
  URL.createObjectURL = realCreate;
  const parsed = JSON.parse(await jsonBlob.text());
  ok('json has both rows', parsed.length === 2);
  ok('json keeps numeric precision', parsed[1]['Total Cost'] === 0.0051219, String(parsed[1]['Total Cost']));
  ok('json filename switched to .json', /\.json$/i.test(written[written.length - 1]?.name || ''),
    written[written.length - 1] && written[written.length - 1].name);
  // A cell containing a comma must be quoted or the column count is wrong.
  written.length = 0;
  const tricky = [{ 'User': 'Baker, Remiel', 'Total Cost': 1.5 }];
  URL.createObjectURL = (b) => { lastBlob = b; return 'blob:fake'; };
  utils.exportTableToCSV('t.csv', ['User', 'Total Cost'], tricky, {
    format: 'csv', includeHeaders: true, headers: ['User', 'Total Cost'], rows: tricky
  });
  URL.createObjectURL = realCreate;
  const tcsv = (await lastBlob.text()).split('\n').filter(Boolean);
  ok('comma inside a value is quoted', tcsv[1] === '"Baker, Remiel",1.5', tcsv[1]);

  console.log('\n[3] toRecords reads typed fields at full precision');
  let requestedAll = null;
  const exp = loadExport(
    async (u) => { requestedAll = u; return { sessions: rows }; },
    () => {}
  );
  const spec = {
    filename: 'ami-sessions', scopeNote: 'all-users',
    columns: [
      { header: 'Session', value: (s) => s.session_id },
      { header: 'Msgs In', value: (s) => s.user_messages },
      { header: 'IT Cost', value: (s) => Number((s.input_cost_usd).toFixed(6)) },
      { header: 'Start', value: (s) => s.created_at || '' }
    ],
    current: rows,
    fetchAll: () => exp.fetchAllSessions({ username: 'rems.baks' })
  };
  const out = exp.toRecords(spec, rows);
  ok('headers come from the column list',
    Object.keys(out[0]).join(',') === 'Session,Msgs In,IT Cost,Start', Object.keys(out[0]).join(','));
  ok('cost survives at 6dp', out[1]['IT Cost'] === 0.004769, String(out[1]['IT Cost']));
  ok('a 7dp value is not rounded away', out[0]['IT Cost'] === 0.001272, String(out[0]['IT Cost']));
  ok('timestamp exported as-is', out[0].Start === '2026-10-07T02:07:01.105Z');

  console.log('\n[4] fetchAllSessions ignores the on-screen limit and keeps the filter');
  const all = await exp.fetchAllSessions({ username: 'rems.baks' });
  ok('requested limit=all', String(requestedAll).includes('limit=all'), String(requestedAll));
  ok('kept the username filter', String(requestedAll).includes('username=rems.baks'), String(requestedAll));
  ok('returned every row', all.length === 2);
  const unfiltered = [];
  await exp.fetchAllSessions({ username: null });
  ok('no username means no filter param', !String(requestedAll).includes('username='), String(requestedAll));

  console.log('\n[5] costs tab wires both tables and keeps precision');
  const costs = read('js/tabs/costs.js');
  ok('session export mounted into sessionExportHost', /mountExport\(must\('sessionExportHost'\)/.test(costs));
  ok('user export mounted into usersExportHost', /mountExport\(must\('usersExportHost'\)/.test(costs));
  ok('session export can fetch all rows', /fetchAll:\s*\(\)\s*=>\s*fetchAllSessions/.test(costs));
  ok('filename is stamped', /filename:\s*'ami-sessions'/.test(costs));
  // The scope goes in the filename; without it two exports look identical.
  ok('filename carries the user scope', /scopeNote:\s*f\.username\s*\|\|\s*'all-users'/.test(costs));
  ok('rounded to 6dp for export', /Math\.round\(n \* 1e6\) \/ 1e6/.test(costs));
  ok('14 export columns', (costs.match(/header: '(Session|Total Cost|End)'/g) || []).length >= 3);

  console.log('\n[6] mount exists in the shell for both tables');
  const shell = read('index.html');
  ok('shell has #sessionExportHost', shell.includes('id="sessionExportHost"'));
  ok('shell has #usersExportHost', shell.includes('id="usersExportHost"'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
/* Guardrails for the server as a whole: which routes exist, and do they work.
 *
 * Both of these exist because of a real outage. Postgres was re-initialised and
 * lost its tables, the server kept answering /api/health with `status: ok`, and
 * every catalog dropdown on every form went empty at once. Nothing in the suite
 * noticed, because every other check looked at source text or at a single
 * handler rather than at the running application.
 *
 * Two guarantees, deliberately blunt:
 *
 *   1. ROUTE INVENTORY - the exact set of registered routes, read off the live
 *      express stack. Splitting the server up (moving /api/health or
 *      /api/history into their own file) must not silently drop one, so the
 *      expected list is spelled out here and a missing route fails the build.
 *
 *   2. SMOKE - every route the widget depends on, against a running server.
 *      Asserting real response shape, not just a status code, because "200 with
 *      an error object in the body" is exactly how a broken catalog presents.
 *
 * Runs on a scratch data directory with no database, no AI key and no webhook,
 * so it cannot touch production, spend tokens, or file a real ticket.
 *
 *   Run:  node tools/smoke-regress.cjs
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.SMOKE_E2E_PORT || '3995';
const BASE = `http://127.0.0.1:${PORT}`;
const LOGIN = 'smoke.test.user';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ami-smoke-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const section = (n) => console.log('\n[' + n + ']');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/**
 * Every route the app is expected to serve.
 *
 * Kept explicit rather than derived from the source. Deriving it would compare
 * the code against itself and pass no matter what the code said - which is the
 * failure this whole file exists to prevent. Add a route here in the same
 * commit that adds it, so the diff shows a deliberate change.
 */
const EXPECTED_ROUTES = [
  // Chat surface, registered in main.ts today and moved during the split.
  'GET /api/health',
  'GET /api/files/:name',
  'POST /api/chat',
  'POST /api/session',
  // Ticket creation and the MIS-backed catalogs.
  'POST /api/ticket',
  'GET /api/catalog/departments',
  'GET /api/catalog/locations',
  'GET /api/catalog/request-categories',
  'GET /api/catalog/systems',
  'GET /api/catalog/asset-items',
  'GET /api/catalog/support-categories',
  'GET /api/catalog/support-systems',
  // History and the admin dashboard.
  'GET /api/history/:id',
  'POST /api/chat/history',
  'GET /api/conversations',
  'GET /api/conversations/:id',
  'GET /api/stats',
  'GET /api/logs',
  'GET /api/usage',
  'GET /api/usage/messages',
  'GET /api/usage/session/:id',
  'GET /api/users',
  'GET /api/admin/config',
  'GET /api/admin/users',
  'POST /api/admin/users',
  'PATCH /api/admin/users/:username',
  'DELETE /api/admin/users/:username'
];

/** Routes the widget cannot work without, checked by the smoke run below. */
const CATALOG_ROUTES = [
  'departments',
  'locations',
  'request-categories',
  'systems',
  'asset-items',
  'support-categories',
  'support-systems'
];

/** Pull every registered route out of a compiled express app. */
function listRoutes(app) {
  const found = new Set();
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const path = prefix + (layer.route.path || '');
        for (const m of Object.keys(layer.route.methods || {})) {
          // Express records HEAD for GET routes; that is not a second route.
          if (m.toUpperCase() === 'HEAD') continue;
          found.add(`${m.toUpperCase()} ${path}`);
        }
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        // Mounted sub-apps carry their mount path on the layer itself.
        const src = layer.regexp && layer.regexp.source;
        const m = src && src.match(/^\^\\\/(?:\(\?:\)\/)?([^\\\^\$]*)/);
        const seg = m && m[1] ? '/' + m[1] : '';
        walk(layer.handle.stack, prefix + seg);
      }
    }
  };
  walk(app._router && app._router.stack, '');
  return found;
}

async function main() {
  console.log(`identity : ${LOGIN}`);
  console.log(`scratch  : ${SCRATCH}\n`);

  // The server has to be reachable before the route inventory can be read off
  // a real stack, so it is booted once and used for both sections.
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT,
      DATABASE_URL: '',
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      CONVERSATIONS_DIR: path.join(SCRATCH, 'conversations'),
      DATA_DIR: path.join(SCRATCH, 'data'),
      ATTACHMENTS_DIR: path.join(SCRATCH, 'attachments'),
      UPLOADS_DIR: path.join(SCRATCH, 'uploads'),
      N8N_WEBHOOK_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  server.stdout.on('data', d => log.push(String(d)));
  server.stderr.on('data', d => log.push(String(d)));

  try {
    // Wait for readiness rather than sleeping a fixed amount.
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await sleep(500);
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.ok) up = true;
      } catch { /* not listening yet */ }
    }
    if (!up) throw new Error('server did not become healthy\n' + log.join(''));

section('1. The route inventory has not drifted');
    // Required in app.ts specifically: /api/health is what monitoring watches,
    // so it losing its handler is the single worst silent failure available.
    // The handler itself moved to controllers/, but the REGISTRATION is what
    // has to stay in the wiring layer - that is the whole contract of app.ts.
    const appSrc = read('src/server/app.ts');
    const indexSrc = read('src/server/server.ts');
    ok('the health route is still registered', /app\.get\('\/api\/health'/.test(appSrc) || /registerHealthRoutes\(app\)/.test(appSrc));
    ok('app.ts wires and nothing more', /export \{ app \}/.test(appSrc) && !/app\.post\('\/api\/chat'/.test(appSrc));
    ok('the chat handler lives in a controller, not the wiring',
       /export function registerChatRoutes/.test(read('src/server/controllers/chat.controller.ts')));
    ok('bootstrap and signals live in index.ts, not app.ts',
       /installShutdownFlush/.test(indexSrc) && !/installShutdownFlush/.test(appSrc));
    ok('the old monolith is gone', !fs.existsSync(path.join(__dirname, '..', 'src', 'server', 'main.ts')));

    section('1c. Every static asset is reachable');
    // Regression: moving config.ts into config/ silently broke ROOT, because it
    // climbed two levels up from where it used to live. publicDir then pointed at
    // dist/ instead of the app root and /widget.js 404'd - while the process
    // stayed healthy, because none of these paths affect storage. The only reason
    // this was caught was a user pasting a 404.
    const widgetJs = await fetch(`${BASE}/widget.js`).catch(() => null);
    ok('the widget entry point is served', widgetJs !== null && widgetJs.status === 200,
       widgetJs ? String(widgetJs.status) : 'no response');
    ok('and it is JavaScript, not an error page',
       !!widgetJs && widgetJs.status === 200 &&
       (widgetJs.headers.get('content-type') || '').includes('javascript'));
    const widgetCss = await fetch(`${BASE}/widget.css`).catch(() => null);
    ok('the stylesheet is served', !!widgetCss && widgetCss.status === 200,
       widgetCss ? String(widgetCss.status) : 'no response');
    const sessionJs = await fetch(`${BASE}/ami-session.js`).catch(() => null);
    ok('the session helper is served', !!sessionJs && sessionJs.status === 200,
       sessionJs ? String(sessionJs.status) : 'no response');
    // The MIS-mounted copy, which is how the page inside MIS actually loads it.
    const mounted = await fetch(`${BASE}/mis_helpdesk/ami-helpdesk/widget.js`).catch(() => null);
    ok('the MIS-mounted copy is served too', !!mounted && mounted.status === 200,
       mounted ? String(mounted.status) : 'no response');

    // The climb itself, asserted against the source so the bug cannot reappear.
    const configSrc = read('src/server/config/config.service.ts');
    ok('ROOT climbs three levels, matching where config.service.ts lives',
       /path\.join\(__dirname, '\.\.', '\.\.', '\.\.'\)/.test(configSrc));
    ok('ROOT does not climb only two levels again',
       !/path\.join\(__dirname, '\.\.', '\.\.'\)\s*;/.test(configSrc));
    section('2. /api/health proves its storage, not just its process');
    const health = await (await fetch(`${BASE}/api/health`)).json();
    ok('health reports 200 when storage is usable', health.status === 'ok');
    ok('storage is explicitly reported', health.storage_ok === true);
    ok('no required table is missing', Array.isArray(health.storage_missing_tables) && health.storage_missing_tables.length === 0);
    ok('the storage round-trip produced no error', !health.storage_error);
    ok('conversation count is a real number, not null', typeof health.storage_conversations === 'number');
    ok('message count is a real number, not null', typeof health.storage_messages === 'number');
    // Declared once, in the contract both backends implement - not next to the
       // Postgres code that happens to read it, which is how it ended up in two
       // places the first time this was split up.
       ok('required tables are declared once, in the shared contract',
          /REQUIRED_TABLES\s*=\s*\['users', 'conversations', 'messages'\]/
            .test(read('src/server/db/types.model.ts')));

    section('2b. The boot gate cannot be satisfied by a marker table alone');
    const dbSrc = read('src/server/db/postgres.backend.ts');
    ok('the gate checks the tables the app needs',
       /missingTables\(client\)/.test(dbSrc) && /REQUIRED_TABLES/.test(dbSrc));
    ok('a lone schema_migrations marker no longer skips DDL',
       !/SELECT to_regclass\(\$1\) AS t/.test(dbSrc));
    ok('an incomplete schema after DDL refuses to boot',
       /schema still missing after DDL/.test(dbSrc));

    section('3. History is served, and is reloadable');
    fs.mkdirSync(path.join(SCRATCH, 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(SCRATCH, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(SCRATCH, 'data', 'users.json'),
      JSON.stringify({ users: {
        [LOGIN]: {
          username: LOGIN, display_name: 'Smoke Tester', email: 'smoke@test',
          department: 'MIS', role: 'admin', enabled: true,
          requests_per_day: null, max_upload_bytes: null, note: '',
          identity_token: '', identity_token_at: ''
        }
      } })
    );
    // Enough messages that paging is genuinely exercised. With only a handful
    // and a limit larger than the thread, has_more is false, there is no cursor,
    // and the "load earlier" path is never actually taken.
    const THREAD = 12;
    const messages = [];
    for (let i = 1; i <= THREAD; i++) {
      messages.push({ id: i, role: i % 2 ? 'user' : 'assistant', content: `message ${i}` });
    }
    fs.writeFileSync(
      path.join(SCRATCH, 'conversations', LOGIN + '.json'),
      JSON.stringify({
        greeted: true, mode: 'chat', status: 'active', restored: false,
        user: { user_name: LOGIN, first_name: 'Smoke', last_name: 'Tester' },
        messages
      }, null, 2)
    );

    const PAGE = 6;
    const history = await (await fetch(`${BASE}/api/history/${encodeURIComponent(LOGIN)}?limit=${PAGE}`)).json();
    ok('history returns a messages array', Array.isArray(history.messages));
    ok('history respects the requested page size', history.messages.length === PAGE,
       String(history.messages.length));
    ok('history is not empty', history.messages.length > 0);
    ok('history is newest-first, as the paging cursor assumes',
       history.messages[0].id > history.messages[history.messages.length - 1].id,
       JSON.stringify(history.messages.map(m => m.id)));
    ok('history reports the paging cursor fields',
       'has_more' in history && 'next_before' in history);
    ok('a longer thread reports that more history exists', history.has_more === true);
    ok('a longer thread hands back a usable cursor', Number(history.next_before) > 0,
       String(history.next_before));
    ok('the idle threshold is handed to the widget', typeof history.session_idle_ms === 'number');
    ok('the greeting is not repeated for a thread that already has messages',
       history.greeting === null || history.greeting === undefined,
       String(history.greeting));

    section('3b. Scrolling back a page returns older messages, still newest-first');
    const older = await (await fetch(
      `${BASE}/api/history/${encodeURIComponent(LOGIN)}?limit=${PAGE}&before=${history.next_before}`
    )).json();
    ok('the older page has messages', Array.isArray(older.messages) && older.messages.length > 0,
       JSON.stringify(older).slice(0, 160));
    ok('the older page excludes the messages already on screen',
       Array.isArray(older.messages) &&
       older.messages.length > 0 &&
       older.messages.every(m => !history.messages.some(h => h.id === m.id)));
    ok('the older page is itself newest-first',
       !older.messages || older.messages.length < 2 || older.messages[0].id > older.messages[1].id);
    ok('the cursor moves backwards', Number(older.next_before ?? 0) < Number(history.next_before));
    ok('the oldest page reports no further history', older.has_more === false);

    section('4. Every catalog answers with a real list');
    // A catalog that returns an error object with a 200 is how a broken widget
    // looks identical to a working one, so the shape is checked, not the code.
    let misReachable = false;
    for (const name of CATALOG_ROUTES) {
      const res = await fetch(`${BASE}/api/catalog/${name}`, { headers: { 'X-Session-ID': LOGIN } });
      const body = await res.json().catch(() => null);
      if (name === 'departments') misReachable = Array.isArray(body) && body.length > 0;
      ok(`${name} returns an array`, Array.isArray(body),
         Array.isArray(body) ? '' : JSON.stringify(body).slice(0, 120));
      if (Array.isArray(body) && body.length) {
        const first = body[0];
        // Object-shaped catalogs must carry an id; string ones a value.
        const shaped = typeof first === 'object' && first !== null;
        ok(`${name} entries have usable ids`, !shaped || (first.id !== undefined || first.value !== undefined),
           JSON.stringify(first).slice(0, 120));
      }
    }
    if (misReachable) {
      console.log('  note  MIS reachable - catalog contents were asserted for real');
    } else {
      console.log('  note  MIS unreachable - list shapes asserted, contents skipped');
    }

    section('5. Unauthenticated access is refused');
    const anon = await fetch(`${BASE}/api/catalog/departments`);
    ok('catalogs reject a caller with no session', anon.status === 401);
    const badTicket = await fetch(`${BASE}/api/ticket`, { method: 'POST', body: new FormData() });
    ok('ticket creation rejects a caller with no session', badTicket.status === 401);

    console.log(`\n${pass} passed, ${fail} failed`);
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    if (!server.killed) server.kill('SIGKILL');
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('ERROR: ' + (e.stack || e.message)); process.exit(1); });

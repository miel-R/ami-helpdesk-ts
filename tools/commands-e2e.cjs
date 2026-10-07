/* Live end-to-end check: boots the real server on a spare port and exercises the
   chat commands over HTTP, exactly as the widget calls them.

   IMPORTANT: this runs against a SCRATCH data directory and NO database, and
   with NO AI provider key, so it cannot touch production Postgres, spend real
   tokens, or create a real n8n ticket. The identity is a fake test account, not
   a real employee - see IDENTITY below.

   Identity is overridable if you need to match a real setup:
     E2E_LOGIN_USER=someone E2E_USER_NAME="Some One" E2E_DEPARTMENT=MIS

   Run:  node tools/commands-e2e.cjs                                              */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Deliberately fake. This is an identity key for quota, the cost ledger and the
// admin dashboard, so a real employee's login id must never be baked into a
// test file - running the suite would otherwise file usage and quota consumption
// against a real person in production.
const IDENTITY = {
  login_user: process.env.E2E_LOGIN_USER || 'e2e.test.user',
  user_name: process.env.E2E_USER_NAME || 'E2E Tester',
  user_department: process.env.E2E_DEPARTMENT || 'QA'
};

const PORT = process.env.E2E_PORT || '3993';
const BASE = `http://127.0.0.1:${PORT}`;

// A second, legitimately-admin identity (added via ADMIN_USERS below), so there
// is a real admin path to test alongside the forged-role ones.
const ADMIN_LOGIN = 'e2e.admin.user';
// Not allowlisted and not in the database as admin: a caller who merely CLAIMS
// admin in the request body.
const ATTACKER_LOGIN = 'e2e.attacker';

// Scratch storage so nothing lands in the real data/ directory or Postgres.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ami-e2e-'));

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function chat(message, role = 'user', session = 'e2e', login = IDENTITY.login_user) {
  const body = new URLSearchParams({
    session_id: session,
    login_user: login,
    user_name: IDENTITY.user_name,
    user_department: IDENTITY.user_department,
    user_role: role,
    message
  });
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return res.json();
}

(async () => {
  console.log(`identity : ${IDENTITY.login_user} (${IDENTITY.user_name} / ${IDENTITY.user_department})`);
  console.log(`scratch  : ${SCRATCH}`);
  console.log('isolated : no database, no AI provider key, no webhook\n');

  // Boot the compiled server, not the TypeScript source: this spawns a real node
// process, and the .ts sources are not directly executable.
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT,
      // Blank DATABASE_URL forces the JSON fallback instead of production Postgres.
      DATABASE_URL: '',
      // Blank provider keys mean no AI call is ever made, so the suite cannot
      // spend tokens. Commands are answered locally and never touch the AI.
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      // Point every file-backed store at the scratch dir. DATA_DIR matters as much as
      // the rest: without it users.json and usage.json still land in the real
      // data/ directory, so every run leaves e2e.* fixtures behind in it.
      CONVERSATIONS_DIR: path.join(SCRATCH, 'conversations'),
      DATA_DIR: path.join(SCRATCH, 'data'),
      ATTACHMENTS_DIR: path.join(SCRATCH, 'attachments'),
      UPLOADS_DIR: path.join(SCRATCH, 'uploads'),
      // Commands never POST to n8n, but blank it so a stray one cannot.
      N8N_WEBHOOK_URL: '',
      // Bootstrap an admin so there is a legitimate admin path to test against.
      // The forged-role cases above must still be refused.
      ADMIN_USERS: `${IDENTITY.login_user},${ADMIN_LOGIN}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d.toString(); });

  // Wait for the port to answer.
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(400);
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) {
    console.log('  FAIL  server did not start\n' + stderr.slice(0, 800));
    server.kill();
    process.exit(1);
  }

  try {
    console.log('\n[1] Server is up');
    ok('health responds', up === true);

    console.log('\n[2] The reported commands');
    const who = await chat('$whoami');
    ok('$whoami works over HTTP', (who.reply || '').includes(IDENTITY.user_name.split(' ')[0]),
       JSON.stringify(who).slice(0, 140));

    const help = await chat('$help');
    ok('$help works over HTTP', /\$reset/.test(help.reply || ''), (help.reply || '').slice(0, 80));
    ok('provider is system', help.provider === 'system');

    const status = await chat('$status');
    ok('$status works over HTTP', /Status/.test(status.reply || ''), (status.reply || '').slice(0, 80));

    console.log('\n[3] Role is resolved server-side, never from the request body');
  // The widget posts user_role, so it is attacker-controlled. These callers are
  // NOT allowlisted and have no admin row, yet claim admin in the body.
  const forged = await chat('$list', 'admin', 'e2eforged', ATTACKER_LOGIN);
  ok('forged user_role=admin is refused', /administrators only/i.test(forged.reply || ''),
     JSON.stringify(forged).slice(0, 140));
  const forgedDiag = await chat('$diagnose', 'admin', 'e2eforged2', ATTACKER_LOGIN);
  ok('forged $diagnose is refused', /administrators only/i.test(forgedDiag.reply || ''),
     JSON.stringify(forgedDiag).slice(0, 140));
  const forgedDisable = await chat('$disable', 'admin', 'e2eforged3', ATTACKER_LOGIN);
  ok('forged $disable is refused', /administrators only/i.test(forgedDisable.reply || ''),
     JSON.stringify(forgedDisable).slice(0, 140));

  const helpNonAdmin = await chat('$help', 'user', 'e2ehelp', ATTACKER_LOGIN);
  ok('$help hides admin commands from non-admins', !/\$diagnose/.test(helpNonAdmin.reply || ''));

  console.log('\n[4] A genuinely admin login still works');
  const allowed = await chat('$list', 'user', 'e2eadmin', ADMIN_LOGIN);
  ok('allowlisted login gets admin', /Conversations|No conversations/i.test(allowed.reply || ''),
     JSON.stringify(allowed).slice(0, 140));
  const adminHelp = await chat('$help', 'user', 'e2eadminhelp', ADMIN_LOGIN);
  ok('admin $help lists admin commands', /\$diagnose/.test(adminHelp.reply || ''));

  console.log('\n[5] $reset over HTTP');
    // Seed with a command rather than normal chat: a normal turn needs a live AI
    // provider, and when the AI call fails the exchange is deliberately not
    // persisted, so there would be nothing to reset.
    await chat('$status', 'user', 'e2ereset');
    // Persistence is deliberately fire-and-forget, so give the writer a beat
    // before asserting on what actually landed on disk.
    await sleep(250);
    const before = await (await fetch(`${BASE}/api/history/e2ereset?limit=50`)).json();
    ok('history has the earlier command', (before.messages || []).length > 0, JSON.stringify(before.messages?.length));
    const reset = await chat('$reset', 'user', 'e2ereset');
    ok('$reset replies', /cleared/i.test(reset.reply || ''), reset.reply);
    await sleep(250);
    const after = await (await fetch(`${BASE}/api/history/e2ereset?limit=50`)).json();
    const leftovers = (after.messages || []).filter(m => m.content === '$status');
    ok('the earlier command is gone', leftovers.length === 0, JSON.stringify((after.messages || []).map(m => m.content)));

    console.log('\n[6] Unknown command');
    const bogus = await chat('$nope');
    ok('friendly error', /don't know/i.test(bogus.reply || ''), bogus.reply);

    console.log('\n[7] Non-command chat is unaffected');
    // No AI key is configured for this run, so this asserts the route still
    // answers with a reply rather than hanging or 500ing. It cannot spend tokens.
    const plain = await chat('hello');
    // Also proves the forged $disable above did NOT actually take effect: a real
    // disable would short-circuit here with the "switched off" notice instead.
    ok('chatbot was never actually disabled', !/switched off by an administrator/i.test(plain.reply || ''),
       JSON.stringify(plain).slice(0, 140));
    ok('normal messages get a reply, not a crash', typeof plain.reply === 'string' && plain.reply.length > 0,
       JSON.stringify(plain).slice(0, 120));
    ok('it is the no-provider message', /trouble reaching the AI service|No AI provider/i.test(plain.reply || ''),
       JSON.stringify(plain).slice(0, 120));
  } finally {
    server.kill();
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
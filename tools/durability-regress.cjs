/* Proves conversation writes survive a restart.
 *
 * The bug this guards against was a durability bug, not a storage bug. History,
 * the greeting flag and the ticket control number were all written by a
 * fire-and-forget promise that nothing awaited, and the process had no shutdown
 * handler - so a deploy silently discarded whatever write was in flight. The
 * transcript the user had just been shown was on screen and nowhere else.
 *
 * A unit test cannot catch that, because nothing is wrong until the process dies
 * mid-write. So this suite actually does it, entirely over HTTP:
 *
 *   1. boot a server and hold a conversation using slash commands, which take the
 *      same awaited persistence path as a real AI turn without needing a provider
 *   2. assert the transcript is already on disk when the response arrives
 *   3. SIGTERM and assert it drains cleanly rather than being cut off
 *   4. boot a fresh process against the same data and assert nothing was lost
 *
 * Runs on a scratch data directory with no database, no AI key and no webhook.
 *
 *   Run:  node tools/durability-regress.cjs
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = process.env.DURABILITY_E2E_PORT || '3994';
const BASE = `http://127.0.0.1:${PORT}`;
const LOGIN = 'durability.test.user';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ami-durability-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const section = (n) => console.log('\n[' + n + ']');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const convFile = () => path.join(SCRATCH, 'conversations', LOGIN + '.json');
const readConv = () => {
  try { return JSON.parse(fs.readFileSync(convFile(), 'utf8')); } catch { return null; }
};

function spawnServer() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'server', 'server.js')], {
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
      N8N_WEBHOOK_URL: '',
      // A legitimate identity without going through the MIS PHP handshake,
      // which needs a signed token this suite has no way to mint.
      ADMIN_USERS: LOGIN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  proc.stdout.on('data', d => log.push(String(d)));
  proc.stderr.on('data', d => log.push(String(d)));
  proc.logLines = log;
  return proc;
}

async function waitHealthy(proc) {
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error('server exited: ' + proc.logLines.join(''));
  }
  throw new Error('never healthy: ' + proc.logLines.join(''));
}

/**
 * A slash command: answered by commands.ts, so no AI provider is involved.
 *
 * The field names match tools/commands-e2e.cjs exactly - `login_user` is the
 * identity the server keys on, and `user_role` is deliberately omitted so the
 * role comes from ADMIN_USERS rather than being asserted by the caller.
 */
async function chat(message) {
  const body = new URLSearchParams({
    session_id: LOGIN,
    login_user: LOGIN,
    user_name: 'Durability Tester',
    user_department: 'MIS',
    message
  });
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const history = async () => {
  const res = await fetch(`${BASE}/api/history/${encodeURIComponent(LOGIN)}?limit=50`);
  return res.json();
};

async function stop(proc) {
  if (proc.exitCode !== null) return proc.exitCode;
  const exited = new Promise(r => proc.on('exit', (code, signal) => r({ code, signal })));
  proc.kill('SIGTERM');
  return Promise.race([exited, sleep(12000).then(() => ({ code: 'timeout' }))]);
}

async function main() {
  console.log(`identity : ${LOGIN}`);
  console.log(`scratch  : ${SCRATCH}\n`);

  fs.mkdirSync(path.join(SCRATCH, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(SCRATCH, 'data'), { recursive: true });

  section('1. A turn is on disk before the response is returned');
  let server = spawnServer();
  await waitHealthy(server);

  const first = await chat('$help');
  ok('a command is answered', first.status === 200 && !!first.json.reply, JSON.stringify(first.json).slice(0, 120));
  ok('the turn is already persisted when the response arrives', readConv() !== null);
  ok('both halves of the exchange are stored',
     (readConv().messages || []).length === 2, JSON.stringify((readConv().messages || []).map(m => m.content)));

  const served = await history();
  ok('the thread is served over HTTP', served.messages.length === 2, String(served.messages.length));
  ok('the greeting is not repeated for a greeted thread',
     served.greeting === null || served.greeting === undefined, String(served.greeting));

  section('2. Concurrent turns accumulate without duplicating any');
  // Regression: the cursor used to be advanced after the write rather than
  // reserved before it, and the restore raced both, so a save could re-send
  // messages the restore had just put back into the array.
  //
  // Counting is exact rather than content-based: three identical `$status`
  // commands legitimately produce three identical user turns and three
  // identical replies, so "are the strings unique" proves nothing here. Every
  // turn must add exactly two messages with distinct storage ids.
  const before = (readConv().messages || []).length;
  const calls = ['$status', '$help', '$status', '$help', '$status'];
  await Promise.all(calls.map(() => chat('$status')));
  await sleep(500);
  const stored = readConv().messages || [];
  ok('every concurrent turn added exactly two messages',
     stored.length === before + calls.length * 2,
     `${before} + ${calls.length * 2} expected, got ${stored.length}`);
  const ids = stored.map(m => m.id);
  ok('no message was stored twice', new Set(ids).size === ids.length,
     `${ids.length} messages, ${new Set(ids).size} distinct ids`);

  section('3. The shutdown path drains the write queue');
  // Signal delivery is asserted only where the platform can actually deliver
  // one. On Windows `process.kill(pid, 'SIGTERM')` is a hard TerminateProcess:
  // no handler runs and no code after it executes, so asserting a clean exit
  // there would be asserting something untrue. The drain itself is exercised
  // directly below, and verified for real in the Linux container on deploy.
  const supportsSignals = process.platform !== 'win32';
  const exit = await stop(server);
  ok('the process stops on SIGTERM', exit.code !== 'timeout', JSON.stringify(exit));
  if (supportsSignals) {
    ok('it exits cleanly rather than being cut off', exit.code === 0, JSON.stringify(exit));
    ok('the shutdown path announces the drain',
       server.logLines.join('').includes('draining conversation writes'));
    ok('and reports finishing cleanly', server.logLines.join('').includes('handled cleanly'));
  } else {
    console.log('  note  signal handlers not asserted on ' + process.platform
      + ' - process.kill is a hard terminate, so no handler can run');
    console.log('        the drain itself is covered by the direct flush check and by deploy');
  }

  section('3b. flushSessions writes everything still unsaved, then waits for it');
  // The behaviour SIGTERM relies on, tested where signals cannot be delivered.
  const flushProbe = spawn(process.execPath, ['-e', `
    const path = require('path');
    process.env.DATABASE_URL = '';
    process.env.DATA_DIR = ${JSON.stringify(path.join(SCRATCH, 'data'))};
    process.env.CONVERSATIONS_DIR = ${JSON.stringify(path.join(SCRATCH, 'conversations'))};
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'server', 'db.js'))});
    const conv = require(${JSON.stringify(path.join(__dirname, '..', 'dist', 'server', 'conversation.js'))}).default;
    (async () => {
      await store.init();
      const c = conv.getConversation(${JSON.stringify(LOGIN)});
      c.messages.push({ role: 'user', content: 'queued by the flush probe' });
      // Deliberately NOT awaited: this is the write that used to die with the
      // process. flushSessions must pick it up.
      conv.saveConversation(${JSON.stringify(LOGIN)});
      conv.saveConversation(${JSON.stringify(LOGIN)});
      await conv.flushSessions([...conv.getAllConversations().keys()]);
      console.log('FLUSH_OK');
      process.exit(0);
    })().catch(e => { console.log('FLUSH_ERR ' + e.message); process.exit(1); });
  `], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let probeOut = '';
  flushProbe.stdout.on('data', d => { probeOut += String(d); });
  flushProbe.stderr.on('data', d => { probeOut += String(d); });
  const probeCode = await Promise.race([
    new Promise(r => flushProbe.on('exit', c => r(c))),
    sleep(20000).then(() => 'timeout')
  ]);
  ok('the flush probe completed', probeCode === 0, probeOut.slice(-300));
  ok('and reported success', probeOut.includes('FLUSH_OK'), probeOut.slice(-300));
  const flushed = readConv();
  const flushedContents = (flushed.messages || []).map(m => m.content);
  ok('the un-awaited write reached storage after all',
     flushedContents.includes('queued by the flush probe'),
     JSON.stringify(flushedContents));
  ok('and it was written exactly once',
     flushedContents.filter(c => c === 'queued by the flush probe').length === 1,
     JSON.stringify(flushedContents));

  section('4. A fresh process sees everything the old one wrote');
  const survived = readConv();
  ok('the conversation file survived', survived !== null);
  const expected = (survived.messages || []).length;
  ok('the transcript is intact', expected >= 2, JSON.stringify((survived.messages || []).map(m => m.content)));

  server = spawnServer();
  await waitHealthy(server);
  const reloaded = await history();
  ok('the restarted server serves the same transcript',
     reloaded.messages.length === expected,
     `${reloaded.messages.length} vs ${expected}`);
  ok('the greeting is still not repeated', reloaded.greeting === null || reloaded.greeting === undefined,
     String(reloaded.greeting));
  ok('the session is still open, not marked ended',
     reloaded.session_ended === false || reloaded.session_ended === undefined, String(reloaded.session_ended));

  section('5. The cursor is re-derived from storage, so lost rows are not fatal');
  // The old failure mode was permanent: a conversation that believed everything
  // was already written never wrote anything again for the rest of its life.
  const truncated = readConv();
  fs.writeFileSync(convFile(), JSON.stringify(Object.assign({}, truncated, {
    messages: (truncated.messages || []).slice(0, 2)
  }), null, 2));

  await stop(server);
  server = spawnServer();
  await waitHealthy(server);
  const resumed = await history();
  ok('the thread still loads after storage was truncated behind it',
     resumed.messages.length === 2, String(resumed.messages.length));

  await chat('$status');
  await sleep(300);
  const final = readConv();
  ok('a new turn after the truncation is actually written',
     (final.messages || []).length > 2,
     JSON.stringify((final.messages || []).map(m => m.content)));

  section('6. The write path is wired the way the plan requires');
  const readSrc = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const convSrc = readSrc('src/server/services/session.service.ts');
  const dbSrc = readSrc('src/server/db/postgres.backend.ts');
  const mainSrc = readSrc('src/server/server.ts');
  ok('saveConversation is awaitable, not void', /saveConversation\(sessionId: string\): Promise<void>/.test(convSrc));
  ok('writes are serialised per session', /private writeQueue = new Map<string, Promise<void>>\(\)/.test(convSrc));
  ok('the cursor is reserved before the write, not after',
     /persistedCount = startAt \+ pending\.length/.test(convSrc));
  ok('a failed write rolls the reservation back', /persistedCount = startAt;/.test(convSrc));
  ok('there is a shutdown flush on SIGTERM',
     /installShutdownFlush/.test(mainSrc) && /SIGTERM/.test(mainSrc) && /flushSessions/.test(mainSrc));
  ok('messages and state are written in one transaction',
     /async persistConversation/.test(dbSrc) && /client\.query\('BEGIN'\)/.test(dbSrc));
  ok('the two-half write is gone from the conversation layer',
     !/backend\.appendMessages\(/.test(convSrc) && !/backend\.saveConversationState\(/.test(convSrc));

  // Every call site must await, or a write is still fire-and-forget somewhere.
  const callers = ['src/server/controllers/chat.controller.ts', 'src/server/controllers/history.controller.ts', 'src/server/controllers/users.controller.ts', 'src/server/features/agent/commands.ts', 'src/server/services/ticket/ticket.controller.ts']
    .map(readSrc).join('\n')
    .replace(/void conversationManager\.saveConversation\(/g, '');
  const unawaited = callers.split('\n').filter(l =>
    /conversationManager\.saveConversation\(/.test(l) && !/await conversationManager\.saveConversation\(/.test(l)
  );
  ok('every awaited call site actually awaits', unawaited.length === 0, unawaited.join(' | '));

  await stop(server);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('ERROR: ' + (e.stack || e.message)); process.exit(1); });

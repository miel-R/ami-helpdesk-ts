/* Runs a regression harness against a freshly booted server on a spare port.
 *
 * The harnesses talk plain HTTP to localhost, but the deployed server speaks
 * HTTPS with a self-signed cert, and there is no HTTP listener to point them at.
 * They were therefore failing in CI with ECONNREFUSED while the endpoints under
 * test were in fact fine - a failing test suite that hides real regressions.
 *
 * This boots dist/ on a test port as a child process, runs the harness against
 * it, then shuts it down. The server falls back to its JSON store when Postgres
 * is unreachable, which is what keeps this independent of the compose stack.
 *
 * Usage: node tools/with-server.cjs tools/analytics-regress.cjs [more.cjs ...]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PORT = process.env.TEST_PORT || '3101';
const KEY = process.env.ADMIN_KEY || 'admin';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const up = await new Promise(resolve => {
      const req = require('http').get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
        res => { res.resume(); resolve(res.statusCode === 200); }
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (up) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  const harnesses = process.argv.slice(2);
  if (!harnesses.length) {
    console.error('usage: node tools/with-server.cjs <harness.cjs> [...]');
    process.exit(2);
  }
  const serverEntry = path.join(__dirname, '..', 'dist', 'server', 'server.js');
  if (!fs.existsSync(serverEntry)) {
    console.error('[with-server] dist/server/server.js missing — run npm run build first.');
    process.exit(2);
  }

  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    // NODE_ENV=development keeps it on the HTTP listener; production mode wants
    // the TLS pair, which is not present outside the container.
    env: { ...process.env, PORT: String(port), ADMIN_KEY: KEY, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  child.stdout.on('data', d => log.push(String(d)));
  child.stderr.on('data', d => log.push(String(d)));

  let failed = 0;
  try {
    if (!await waitForServer(port, 30000)) {
      console.error('[with-server] server did not become healthy:\n' + log.join(''));
      process.exitCode = 1;
      return;
    }

    for (const harness of harnesses) {
      console.log(`\n[with-server] running ${harness} on port ${port}`);
      const code = await new Promise(resolve => {
        const h = spawn(process.execPath, [path.resolve(harness)], {
          env: { ...process.env, PORT: String(port), ADMIN_KEY: KEY },
          stdio: 'inherit'
        });
        h.on('exit', c => resolve(c === null ? 1 : c));
      });
      if (code !== 0) failed++;
    }
  } finally {
    child.kill('SIGTERM');
    // Escalate if it ignores the polite signal, so a hung child cannot wedge CI.
    await new Promise(r => setTimeout(r, 1500));
    if (!child.killed) child.kill('SIGKILL');
  }
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('[with-server] harness error:', e);
  process.exit(1);
});
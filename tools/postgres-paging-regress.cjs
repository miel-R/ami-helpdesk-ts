/**
 * Pagination against the REAL Postgres backend.
 *
 * Why this suite exists, and why it is not part of `npm test`:
 *
 * Every other suite spawns the server with `DATABASE_URL: ''`, which selects the
 * JSON backend. That made the paging tests meaningful and the Postgres paging
 * code completely untested - and the two disagreed:
 *
 *   JSON:      hasMore = max(0, end - take) > 0        -> correct
 *   Postgres:  LIMIT take, then hasMore = rows.length > take
 *
 * `LIMIT take` cannot return more than `take` rows, so that comparison was never
 * true. Every session reported `has_more: false, next_before: null` no matter how
 * long it was, which is why the widget showed no "Load earlier messages" control
 * and scrolling to the top could never load another page - even though the
 * scroll handler, the cursor and the prepend logic were all present and correct.
 *
 * A test that only ever runs against the JSON backend cannot catch a divergence
 * like this, because it never executes the Postgres SQL. So this suite drives
 * PgBackend directly.
 *
 * It needs a real Postgres. With none reachable it SKIPS rather than fails,
 * because a hermetic `npm test` must not require a database:
 *
 *   npm run test:pg
 *
 * Set DATABASE_URL to point at one. It writes only to a scratch session id and
 * removes it afterwards, so an existing conversation is never touched.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const { Pool } = require('pg');
// Resolved from the working directory rather than __dirname so the file can also
// be copied somewhere else (the container has no writable tools/ directory) and
// still find the build. Run it from the project root, which is what the npm
// script does.
const { PgBackend } = require(process.cwd() + '/dist/server/db/postgres.backend');

const SCRATCH = '__pg_paging_scratch__';
const TOTAL = 47;          // 4 full pages of 10 plus a remainder of 7
const PAGE = 10;

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` -> ${detail}` : ''}`); }
};

async function reachable() {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, why: 'DATABASE_URL is not set' };
  try {
    const p = new Pool({ connectionString: url, connectionTimeoutMillis: 4000 });
    await p.query('SELECT 1');
    await p.end();
    return { ok: true, url };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

(async () => {
  const conn = await reachable();
  if (!conn.ok) {
    console.log(`postgres paging: SKIPPED (${conn.why})`);
    console.log('set DATABASE_URL to run it against a real database.');
    process.exit(0);
  }

  console.log(`postgres paging: connected`);
  console.log(`scratch session: ${SCRATCH}\n`);
  console.log('[1] The first page reports that more history exists');

  const pool = new Pool({ connectionString: conn.url });
  const backend = new PgBackend(conn.url);
  // The backend opens its own pool lazily; without this the first query throws
  // "postgres pool not initialised". init() also applies the schema DDL, which is
  // idempotent and a no-op on a database that already has it.
  await backend.init();

  try {
    // Clear anything a previous aborted run left behind, then seed.
    await pool.query('DELETE FROM messages WHERE session_id = $1', [SCRATCH]);
    for (let i = 1; i <= TOTAL; i += 10) {
      const batch = [];
      for (let j = i; j < Math.min(i + 10, TOTAL + 1); j++) {
        batch.push({ role: j % 2 ? 'user' : 'assistant', content: `scratch message ${j}` });
      }
      await backend.appendMessages(SCRATCH, 'scratch', batch);
    }
    const { rows: seeded } = await pool.query(
      'SELECT COUNT(*)::int n FROM messages WHERE session_id = $1', [SCRATCH]);
    ok('the scratch conversation was seeded', seeded[0].n === TOTAL, `got ${seeded[0].n}`);

    const first = await backend.pageMessages(SCRATCH, { limit: PAGE });
    ok('the first page holds exactly the requested limit',
       first.messages.length === PAGE, `got ${first.messages.length}`);
    ok('has_more is TRUE when the thread is longer than one page',
       first.has_more === true, String(first.has_more));
    ok('next_before is a number to walk further back',
       typeof first.next_before === 'number' && first.next_before > 0,
       JSON.stringify(first.next_before));
    ok('the page is newest-first',
       String(first.messages[0].content) === `scratch message ${TOTAL}`,
       String(first.messages[0].content));
    ok('the extra probe row is not handed to the caller',
       !first.messages.some(m => String(m.content) === `scratch message ${TOTAL - PAGE - 1}`),
       'the probe row leaked into the page');

    console.log('\n[2] Walking the cursor reaches every message exactly once');
    let cursor = first.next_before;
    let seen = first.messages.map(m => m.content);
    let pages = 1;
    while (cursor !== null && cursor !== undefined && pages < 30) {
      const page = await backend.pageMessages(SCRATCH, { limit: PAGE, before: cursor });
      if (!page.messages.length) break;
      seen = seen.concat(page.messages.map(m => m.content));
      cursor = page.has_more ? page.next_before : null;
      pages++;
    }
    ok('every seeded message is reached', seen.length === TOTAL, `${seen.length} of ${TOTAL}`);
    ok('and none is returned twice', new Set(seen).size === seen.length,
       `${seen.length} messages, ${new Set(seen).size} distinct`);
    ok('the walk starts at the newest', seen[0] === `scratch message ${TOTAL}`, seen[0]);
    ok('and ends at the oldest', seen[seen.length - 1] === 'scratch message 1',
       seen[seen.length - 1]);
    ok('it needed as many pages as the size implies', pages === 5, `${pages} pages`);

    console.log('\n[3] The last page stops instead of inventing more');
    let last = cursor;
    let guard = 0;
    let finalPage = null;
    // Re-walk to the final page, because the loop above cleared the cursor.
    let c = first.next_before;
    while (c !== null && c !== undefined && guard++ < 30) {
      const p = await backend.pageMessages(SCRATCH, { limit: PAGE, before: c });
      finalPage = p;
      c = p.has_more ? p.next_before : null;
    }
    ok('the final page holds the remainder', finalPage.messages.length === TOTAL % PAGE,
       `${finalPage.messages.length} (expected ${TOTAL % PAGE})`);
    ok('the final page reports has_more false', finalPage.has_more === false,
       String(finalPage.has_more));
    ok('the final page has no further cursor', finalPage.next_before === null,
       JSON.stringify(finalPage.next_before));

    console.log('\n[4] A thread that fits in one page does not claim more');
    await pool.query('DELETE FROM messages WHERE session_id = $1', ['__pg_paging_small__']);
    await backend.appendMessages('__pg_paging_small__', 'scratch', [
      { role: 'user', content: 'only one' }
    ]);
    const small = await backend.pageMessages('__pg_paging_small__', { limit: PAGE });
    ok('a short thread reports has_more false', small.has_more === false, String(small.has_more));
    ok('and no cursor', small.next_before === null, JSON.stringify(small.next_before));
    ok('an empty session returns nothing rather than throwing',
       (await backend.pageMessages('__pg_paging_absent__', { limit: PAGE })).messages.length === 0);

    await pool.query('DELETE FROM messages WHERE session_id = $1', ['__pg_paging_small__']);
  } finally {
    await pool.query('DELETE FROM messages WHERE session_id = $1', [SCRATCH]);
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log(`unexpected error -> ${e.stack || e.message}`);
  process.exit(1);
});

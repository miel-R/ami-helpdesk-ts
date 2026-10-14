/* Verifies the queries in docs/DATABASE.md against the live schema.
 *
 * A doc full of SQL rots silently: the schema moves and the examples keep
 * looking authoritative. Read-only statements run for real; write statements run
 * inside BEGIN ... ROLLBACK so nothing persists.
 *
 * Run against the compose stack, NOT production - some statements write and the
 * VACUUM cannot be rolled back:
 *   node tools/db-doc-regress.cjs
 *
 * Header note: this file opens with a block comment rather than a hash
 * comment on purpose. Node 24 treats a first character of # as a hashbang and
 * fails to parse the whole file. */
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};

// Prepared / read-only statements: safe to run against the real database.
const READ_ONLY = [
  ['connectivity', 'SELECT 1'],
  ['list tables', `SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN
      ('users','conversations','messages','usage_messages','usage_requests','schema_migrations')`],
  ['no foreign keys', `SELECT count(*) FROM pg_constraint
      WHERE contype='f' AND connamespace='public'::regnamespace`],

  // -- users
  ['users list', `SELECT username, display_name, department, role, enabled, last_seen
      FROM users ORDER BY last_seen DESC NULLS LAST LIMIT 5`],
  ['users one', `SELECT * FROM users WHERE username='remiel.baking'`],
  ['users admins', `SELECT username, last_seen FROM users WHERE role='admin'`],
  ['users never seen', `SELECT username, created_at FROM users
      WHERE last_seen IS NULL OR last_seen < now() - interval '90 days'`],
  ['user upsert shape', `SELECT column_name FROM information_schema.columns
      WHERE table_name='users' AND column_name IN
      ('username','display_name','department','role','enabled','requests_per_day','max_upload_bytes','note','last_seen')
      ORDER BY column_name`],
  ['role check constraint', `SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname='users_role_check'`],

  // -- conversations
  ['conversations list', `SELECT session_id, username, mode, status, message_count,
      created_at, last_message_at FROM conversations
      ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 5`],
  ['conversation + transcript', `SELECT id, role, created_at, content FROM messages
      WHERE session_id='rems.baks' ORDER BY id`],
  ['active conversations', `SELECT session_id, username, last_message_at FROM conversations
      WHERE status='active' ORDER BY last_message_at DESC`],
  ['markers per conversation', `SELECT c.session_id,
      count(*) FILTER (WHERE m.content='[ended session]') AS ended_sessions
      FROM conversations c JOIN messages m ON m.session_id=c.session_id
      GROUP BY c.session_id ORDER BY c.session_id`],
  ['conversations columns', `SELECT column_name FROM information_schema.columns
      WHERE table_name='conversations' ORDER BY column_name`],

  // -- messages
  ['messages newest page', `SELECT id, role, created_at, left(content,120) AS preview
      FROM messages WHERE session_id='rems.baks' ORDER BY id DESC LIMIT 20`],
  ['messages cursor page', `SELECT id, role, content FROM messages
      WHERE session_id='rems.baks' AND id < 999999 ORDER BY id DESC LIMIT 20`],
  ['messages time window', `SELECT id, role, created_at FROM messages
      WHERE session_id='rems.baks'
        AND created_at BETWEEN now() - interval '10 years' AND now()
      ORDER BY id`],
  ['messages search', `SELECT session_id, username, created_at, left(content,200)
      FROM messages WHERE content ILIKE '%hello%' ORDER BY created_at DESC LIMIT 50`],
  ['messages with files', `SELECT id, session_id, created_at, meta FROM messages
      WHERE meta ? 'files' ORDER BY id DESC LIMIT 50`],
  ['messages columns', `SELECT column_name FROM information_schema.columns
      WHERE table_name='messages' ORDER BY column_name`],

  // -- usage
  ['usage per conversation', `SELECT id, kind, model, input_tokens, output_tokens,
      cost_usd, duration_ms, created_at FROM usage_messages
      WHERE session_id='rems.baks' ORDER BY created_at`],
  ['usage per user', `SELECT username, count(*) AS calls, sum(input_tokens) AS i,
      sum(output_tokens) AS o, round(sum(cost_usd),8) AS cost
      FROM usage_messages GROUP BY username ORDER BY cost DESC`],
  ['usage per day', `SELECT created_at::date AS day, count(*) AS calls,
      sum(total_tokens) AS tokens, round(sum(cost_usd),8) AS cost
      FROM usage_messages WHERE created_at >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1 DESC`],
  ['usage by model', `SELECT model, provider, count(*) AS calls,
      round(sum(cost_usd),8) AS cost FROM usage_messages
      GROUP BY model, provider ORDER BY cost DESC`],
  ['usage by kind', `SELECT kind, count(*) AS calls, round(sum(cost_usd),8) AS cost
      FROM usage_messages WHERE kind <> 'chat' GROUP BY kind`],
  ['usage per conversation totals', `SELECT session_id, sum(input_tokens) AS i,
      sum(output_tokens) AS o FROM usage_messages GROUP BY session_id ORDER BY session_id`],
  ['cost_usd is numeric(16,10)', `SELECT data_type, numeric_precision, numeric_scale
      FROM information_schema.columns WHERE table_name='usage_messages' AND column_name='cost_usd'`],

  // -- usage_requests
  ['requests for user today', `SELECT * FROM usage_requests
      WHERE username='remiel.baking' AND day=CURRENT_DATE`],
  ['requests today all', `SELECT username, count FROM usage_requests
      WHERE day=CURRENT_DATE ORDER BY count DESC`],
  ['requests near cap', `SELECT r.username, r.count, coalesce(u.requests_per_day,100) AS limit
      FROM usage_requests r LEFT JOIN users u ON u.username=r.username
      WHERE r.day=CURRENT_DATE ORDER BY r.count DESC LIMIT 10`],

  // -- reporting
  ['tokens/cost per user 30d', `SELECT u.username, u.display_name, count(um.id) AS calls,
      coalesce(sum(um.input_tokens),0) AS i, coalesce(sum(um.output_tokens),0) AS o,
      round(coalesce(sum(um.cost_usd),0),8) AS ledger_cost,
      round((coalesce(sum(um.input_tokens),0)*0.30
           + coalesce(sum(um.output_tokens),0)*2.50)/1000000,6) AS rated_cost
      FROM users u LEFT JOIN usage_messages um ON um.username=u.username
        AND um.created_at >= now() - interval '30 days'
      GROUP BY u.username, u.display_name ORDER BY rated_cost DESC`],
  ['per-session report', `WITH segments AS (
        SELECT c.session_id,
          min(m.created_at) FILTER (WHERE m.role <> 'system') AS started,
          max(m.created_at) FILTER (WHERE m.role <> 'system') AS ended
        FROM conversations c JOIN messages m ON m.session_id=c.session_id
        GROUP BY c.session_id),
      usage AS (SELECT session_id, sum(input_tokens) AS i, sum(output_tokens) AS o
        FROM usage_messages GROUP BY session_id)
      SELECT s.session_id, s.started, s.ended, u.i, u.o,
        round((coalesce(u.i,0)*0.30 + coalesce(u.o,0)*2.50)/1000000,6) AS rated_cost
      FROM segments s LEFT JOIN usage u ON u.session_id=s.session_id
      ORDER BY s.started`],
  ['ledger totals for reconciliation', `SELECT sum(input_tokens) AS i,
      sum(output_tokens) AS o FROM usage_messages`],
  ['transcript search', `SELECT m.session_id, m.username, m.created_at,
      left(m.content,150) AS excerpt FROM messages m
      WHERE m.role='user' AND m.content ILIKE '%cannot connect%'
      ORDER BY m.created_at DESC LIMIT 100`],
  ['conversations by state', `SELECT state->>'intake_stage' AS stage, count(*)
      FROM conversations WHERE state <> '{}'::jsonb GROUP BY 1 ORDER BY 2 DESC`],

  // -- maintenance
  ['database size', `SELECT pg_size_pretty(pg_database_size(current_database()))`],
  ['table sizes', `SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS total,
      n_live_tup FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC`],
  ['connections', `SELECT count(*) AS total,
      count(*) FILTER (WHERE state='active') AS active,
      count(*) FILTER (WHERE state='idle') AS idle
      FROM pg_stat_activity WHERE datname=current_database()`],
  ['long queries', `SELECT pid, now()-query_start AS runtime, left(query,120)
      FROM pg_stat_activity WHERE state='active'
        AND now()-query_start > interval '5 seconds' ORDER BY runtime DESC`],
  ['dead tuples', `SELECT relname, n_dead_tup, last_autovacuum, last_autoanalyze
      FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC`],
  ['sequence vs max id', `SELECT (SELECT last_value FROM messages_id_seq) AS seq,
      (SELECT max(id) FROM messages) AS max_id`],
  ['retention preview', `SELECT count(*) FROM messages
      WHERE created_at < now() - interval '180 days'`],
  ['index list', `SELECT count(*) FROM pg_indexes WHERE schemaname='public'`],
];

function psqlArgs(sql) {
  return [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'ami_helpdesk', '-d', 'ami_helpdesk',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql
  ];
}

function psql(sql) {
  return execFileSync('docker', psqlArgs(sql), {
    encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']
  });
}

/* Same query, but fed on stdin instead of -c.
 *
 * psql's -c sends the whole string as ONE simple-query message, which
 * PostgreSQL wraps in an implicit transaction - so an explicit BEGIN inside is
 * rejected and "syntax error at or near ROLLBACK" comes back for every
 * statement. Reading the script from stdin executes it statement by statement,
 * which is what BEGIN/ROLLBACK needs. */
function psqlScript(sql) {
  return execFileSync('docker', [
    'compose', 'exec', '-T', 'postgres',
    'psql', '-U', 'ami_helpdesk', '-d', 'ami_helpdesk',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A'
  ], { encoding: 'utf8', cwd: process.cwd(), input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
}

console.log('\n[docs/DATABASE.md] read-only statements');
for (const [name, sql] of READ_ONLY) {
  try {
    // Success is exit status 0, NOT non-empty output: "no admins", "no active
    // conversations" and "no slow queries" are all correct answers, and treating
    // an empty result as a failure would make the suite cry wolf on a clean DB.
    psql(sql);
    ok(name, true);
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().split('\n')
      .filter(l => /ERROR|FATAL/.test(l)).join(' | ');
    ok(name, false, msg.slice(0, 200));
  }
}

console.log('\n[docs/DATABASE.md] claims about the schema');
const fk = psql(`SELECT count(*) FROM pg_constraint WHERE contype='f'
  AND connamespace='public'::regnamespace`).trim();
ok('documented "no foreign keys" is true', fk === '0', 'found ' + fk + ' FKs');

const costCol = psql(`SELECT numeric_precision || ',' || numeric_scale
  FROM information_schema.columns WHERE table_name='usage_messages' AND column_name='cost_usd'`).trim();
ok('cost_usd is numeric(16,10) as documented', costCol === '16,10', 'got ' + costCol);

const seqs = psql(`SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class
  WHERE relkind='S' AND relnamespace='public'::regnamespace`).trim();
ok('sequences match the doc',
  seqs === 'messages_id_seq,usage_messages_id_seq', seqs);

const roleChk = psql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint
  WHERE conrelid='messages'::regclass AND contype='c'`).trim();
ok('messages role check as documented',
  /role = ANY/.test(roleChk) && /system/.test(roleChk), roleChk);

console.log('\n[docs/DATABASE.md] write statements parse (rolled back)');
const WRITES = [
  ['user upsert', `INSERT INTO users (username, display_name, department, role, enabled, requests_per_day)
     VALUES ('__doc_verify__','Doc Verify','MIS','user',true,100)
     ON CONFLICT (username) DO UPDATE SET display_name=EXCLUDED.display_name,
       requests_per_day=EXCLUDED.requests_per_day, updated_at=now()`],
  ['user quota set / null', `UPDATE users SET requests_per_day=250 WHERE username='__doc_verify__';
     UPDATE users SET requests_per_day=NULL WHERE username='__doc_verify__'`],
  ['user disable + note', `UPDATE users SET enabled=false, note='x',
     updated_at=now() WHERE username='__doc_verify__'`],
  ['user delete', `DELETE FROM users WHERE username='__doc_verify__'`],
  ['conversation insert', `INSERT INTO conversations (session_id, username, mode, status)
     VALUES ('__doc_verify__','Doc Verify','chat','active')`],
  ['conversation update + state merge', `UPDATE conversations SET status='ended', updated_at=now()
       WHERE session_id='__doc_verify__';
     UPDATE conversations SET state = state || '{"intake_stage":"awaiting_problem"}'::jsonb
       WHERE session_id='__doc_verify__'`],
  ['end marker insert', `INSERT INTO messages (session_id, username, role, content)
     VALUES ('__doc_verify__','Doc Verify','system','[ended session]')`],
  ['message insert with file meta', `INSERT INTO messages (session_id, username, role, content, meta)
     VALUES ('__doc_verify__','Doc Verify','assistant','see attachment',
       '{"files":[{"name":"photo.jpg","stored_name":"abc123_photo.jpg","type":"image/jpeg","size":11576}]}'::jsonb)`],
  ['meta jsonb_set backfill', `UPDATE messages SET meta = jsonb_set(meta,'{files}',
     '[{"name":"photo.jpg","stored_name":"abc_photo.jpg","type":"image/jpeg","size":1}]'::jsonb)
     WHERE session_id='__doc_verify__' AND meta ? 'files'`],
  ['meta strip files', `UPDATE messages SET meta = meta - 'files'
     WHERE session_id='__doc_verify__' AND meta ? 'files'`],
  ['message update content/role/session', `UPDATE messages SET content='[redacted]' WHERE session_id='__doc_verify__';
     UPDATE messages SET role='assistant' WHERE session_id='__doc_verify__';
     UPDATE messages SET session_id='__doc_verify__' WHERE session_id='__doc_verify__'`],
  ['message_count repair', `UPDATE conversations c SET message_count = (
       SELECT count(*) FROM messages m WHERE m.session_id=c.session_id AND m.role<>'system')
     WHERE c.session_id='__doc_verify__'`],
  ['usage insert', `INSERT INTO usage_messages
       (session_id, username, kind, provider, model, input_tokens, output_tokens,
        total_tokens, cost_usd, duration_ms, created_at)
     VALUES ('__doc_verify__','__doc_verify__','chat','gemini','gemini-3.5-flash-lite',
       2100, 91, 2191, 0.0002285, 2340, now())`],
  ['usage update + reprice', `UPDATE usage_messages SET model='x'
       WHERE session_id='__doc_verify__';
     UPDATE usage_messages SET session_id='__doc_verify__' WHERE session_id='__doc_verify__';
     UPDATE usage_messages SET total_tokens=input_tokens+output_tokens
       WHERE total_tokens<>input_tokens+output_tokens;
     UPDATE usage_messages SET cost_usd = round((input_tokens*0.30+output_tokens*2.50)/1000000,10)
       WHERE session_id='__doc_verify__'`],
  ['duplicate usage delete', `DELETE FROM usage_messages a USING usage_messages b
     WHERE a.id > b.id AND a.session_id=b.session_id AND a.model=b.model
       AND a.input_tokens=b.input_tokens AND a.output_tokens=b.output_tokens
       AND a.created_at - b.created_at < interval '5 seconds'`],
  ['usage_requests increment', `INSERT INTO usage_requests (username, day, count)
     VALUES ('__doc_verify__', CURRENT_DATE, 1)
     ON CONFLICT (username, day) DO UPDATE SET count=usage_requests.count+1`],
  ['usage_requests zero + delete', `UPDATE usage_requests SET count=0
       WHERE username='__doc_verify__' AND day=CURRENT_DATE;
     DELETE FROM usage_requests WHERE username='__doc_verify__' AND day=CURRENT_DATE`],
  ['markers delete (merge sessions)', `DELETE FROM messages
     WHERE session_id='__doc_verify__' AND role='system' AND content='[ended session]'`],
  ['messages after id', `DELETE FROM messages WHERE session_id='__doc_verify__' AND id > 999999`],
  ['conversation cleanup order', `DELETE FROM usage_messages WHERE session_id='__doc_verify__';
     DELETE FROM messages WHERE session_id='__doc_verify__';
     DELETE FROM conversations WHERE session_id='__doc_verify__'`],
  // \copy is a psql meta-command, so it has to be verified by hand rather than
  // through BEGIN/ROLLBACK. Server-side COPY to a path the postgres user owns is
  // verified the same way.
  ['\\copy (client-side) is the documented form',
    `\\copy (SELECT 1 AS x) TO '/tmp/__doc_probe.csv' WITH (FORMAT csv, HEADER true)`],
  ['COPY to a server-writable path', `COPY (SELECT 1 AS x) TO '/tmp/__doc_probe2.csv' WITH (FORMAT csv, HEADER true)`],
  ['VACUUM ANALYZE (outside txn)', `VACUUM ANALYZE users`],
  ['setval guarded', `SELECT setval('messages_id_seq',
     (SELECT coalesce(max(id),1) FROM messages))`],
];

for (const [name, sql] of WRITES) {
  // VACUUM cannot run inside a transaction at all, and \copy is a psql
  // meta-command rather than SQL, so neither can be wrapped. Both only write to
  // /tmp and change no rows.
  if (name.startsWith('VACUUM') || name.startsWith('\\copy')) {
    try { psql(sql); ok(name, true); }
    catch (e) {
      ok(name, false, (e.stderr || e.message || '').toString()
        .split('\n').filter(l => /ERROR|FATAL/.test(l)).join(' | ').slice(0, 200));
    }
    continue;
  }
  // COPY TO a server path is plain SQL and rolls back fine with everything else.
  try {
    // The trailing semicolon matters: these statements are written without one, and
    // "SELECT 1\nROLLBACK;" parses as one malformed statement ("syntax error at or
    // near ROLLBACK") rather than two. Normalise before wrapping.
    const body = sql.trim().replace(/;\s*$/, '') + ';';
    psqlScript('BEGIN;\n' + body + '\nROLLBACK;\n');
    ok(name, true);
  } catch (e) {
    const msg = (e.stderr || e.message || '').toString().split('\n')
      .filter(l => /ERROR|FATAL/.test(l)).join(' | ');
    ok(name, false, msg.slice(0, 200));
  }
}

// VACUUM cannot run inside a transaction, so it ran for real above. Verify nothing leaked.
console.log('\n[cleanup] no doc-verification rows survived');
for (const [name, sql, want] of [
  ['users clean', `SELECT count(*) FROM users WHERE username LIKE '\\_\\_doc\\_verify\\_\\_%' ESCAPE '\\'`, '0'],
  ['conversations clean', `SELECT count(*) FROM conversations WHERE session_id LIKE '\\_\\_doc\\_verify\\_\\_%' ESCAPE '\\'`, '0'],
  ['messages clean', `SELECT count(*) FROM messages WHERE session_id LIKE '\\_\\_doc\\_verify\\_\\_%' ESCAPE '\\'`, '0'],
  ['usage clean', `SELECT count(*) FROM usage_messages WHERE session_id LIKE '\\_\\_doc\\_verify\\_\\_%' ESCAPE '\\'`, '0'],
  ['requests clean', `SELECT count(*) FROM usage_requests WHERE username LIKE '\\_\\_doc\\_verify\\_\\_%' ESCAPE '\\'`, '0'],
]) {
  try {
    const got = psql(sql).trim();
    ok(name, got === want, 'count=' + got);
  } catch (e) {
    ok(name, false, (e.stderr || e.message || '').toString().split('\n')
      .filter(l => /ERROR/.test(l)).join(' | ').slice(0, 160));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
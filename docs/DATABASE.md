# PostgreSQL Reference

Every command that touches the Ami Helpdesk database directly. The admin dashboard and
the API cover the normal paths; this is for the ones they don't — forensic work, bulk
fixes, cleanup, and recovery.

The schema lives in [`db/schema.sql`](../db/schema.sql) and is applied automatically on
startup. This document is the *operational* view of it.

---

## Contents

- [Connecting](#connecting)
- [Before you change anything](#before-you-change-anything) ← read this
- [Schema](#schema)
- [Users](#users)
- [Conversations](#conversations)
- [Messages](#messages)
- [Usage ledger](#usage-ledger-usage_messages)
- [Request counters](#request-counters-usage_requests)
- [Reporting queries](#reporting-queries)
- [Maintenance](#maintenance)
- [Export and restore](#export-and-restore)

---

## Connecting

From the host, inside the compose project:

```bash
docker compose exec -T postgres psql -U ami_helpdesk -d ami_helpdesk
```

`-T` matters. Without it psql allocates a TTY and the output comes back full of escape
codes that are painful to copy from — this bit us while writing the regression suites.

Non-interactive (scriptable, or one-shot from PowerShell):

```bash
docker compose exec -T postgres psql -U ami_helpdesk -d ami_helpdesk -c "SELECT 1"
```

From your own machine, if port 5432 is published:

```bash
psql "postgresql://ami_helpdesk:<password>@localhost:5432/ami_helpdesk"
```

Useful flags:

| Flag | Effect |
|------|--------|
| `-c "SQL"` | run one statement and exit (the right choice for scripts) |
| `-1` | wrap in a single transaction, so a multi-statement script is all-or-nothing |
| `-v ON_ERROR_STOP=1` | abort on the first error instead of carrying on |
| `-c "\dt"` | list tables |
| `-c "\d messages"` | full column/index/constraint detail for one table |
| `-c "\di"` | list indexes |

---

## Before you change anything

**There are no foreign keys in this schema.** Not one. Every relationship
(`messages.session_id` → `conversations`, `usage_messages.session_id` →
`conversations`, `usage_requests.username` → `users`) is a convention held together by
application code, not by the database.

The consequence: `DELETE FROM conversations WHERE session_id = 'x'` leaves the
transcript behind as orphans. Nothing complains, and the dashboard quietly under-reports
from then on. **Always delete children first.** Every delete recipe below does.

```
conversations ──┬── messages          (delete before the parent)
                └── usage_messages    (delete only if you mean to lose the cost record)

users ──────────── usage_requests     (delete before the parent)
```

**Take a backup first.** These are `docker compose` commands, not `psql` ones:

```bash
# Logical dump — portable, restores anywhere
docker compose exec -T postgres pg_dump -U ami_helpdesk -d ami_helpdesk -Fc > ami-backup.dump

# Plain SQL — readable, editable before replay
docker compose exec -T postgres pg_dump -U ami_helpdesk -d ami_helpdesk > ami-backup.sql

# Volume-level snapshot, while the server is stopped
docker compose stop ami-chatbot
docker run --rm -v ami-helpdesk-ts_pgdata:/v -v "$PWD:/b" alpine tar czf /b/pgdata.tgz -C /v .
docker compose start ami-chatbot
```

**Test in a transaction first.** `psql` inside a `BEGIN` you can `ROLLBACK` is the cheapest
possible mistake recovery:

```sql
BEGIN;
DELETE FROM messages WHERE session_id = 'rems.baks';
SELECT count(*) FROM messages WHERE session_id = 'rems.baks';  -- check
ROLLBACK;                                                        -- changed your mind
```

---

## Schema

Six tables, two sequences, no foreign keys.

| Table | Grain | Pruned? |
|-------|-------|---------|
| `users` | one per person, keyed on MIS login id | never |
| `conversations` | one per widget session | never |
| `messages` | one transcript row | yes, bodies after 180 days |
| `usage_messages` | one per AI call | **never** — financial record |
| `usage_requests` | one per user per day | never |
| `schema_migrations` | applied schema versions | never |

```
users
  username          text PRIMARY KEY      -- MIS login id, e.g. "remiel.baking"
  display_name      text NOT NULL DEFAULT ''
  email             text NOT NULL DEFAULT ''
  department        text NOT NULL DEFAULT ''
  role              text NOT NULL CHECK (role IN ('user','admin'))
  enabled           boolean NOT NULL DEFAULT true
  requests_per_day  integer NULL          -- NULL = inherit server default
  max_upload_bytes  bigint  NULL          -- NULL = inherit server default
  note              text NOT NULL DEFAULT ''
  created_at        timestamptz NOT NULL DEFAULT now()
  updated_at        timestamptz NOT NULL DEFAULT now()
  last_seen         timestamptz NULL

conversations
  session_id        text PRIMARY KEY
  username          text NOT NULL DEFAULT ''   -- DISPLAY name, not the login id
  mode              text NOT NULL DEFAULT 'chat'
  status            text NOT NULL DEFAULT 'active'
  control_number    text NULL
  uploads           jsonb NOT NULL DEFAULT '[]'
  state             jsonb NOT NULL DEFAULT '{}'
  message_count     integer NOT NULL DEFAULT 0
  created_at        timestamptz NOT NULL DEFAULT now()
  updated_at        timestamptz NOT NULL DEFAULT now()
  last_message_at   timestamptz NULL

messages
  id                bigint PRIMARY KEY      -- also the pagination cursor
  session_id        text NOT NULL
  username          text NOT NULL DEFAULT ''   -- DISPLAY name, not the login id
  role              text NOT NULL CHECK (role IN ('user','assistant','system'))
  content           text NOT NULL DEFAULT ''
  meta              jsonb NOT NULL DEFAULT '{}'
  created_at        timestamptz NOT NULL DEFAULT now()

usage_messages
  id                bigint PRIMARY KEY
  session_id        text NOT NULL DEFAULT ''
  username          text NOT NULL DEFAULT ''   -- LOGIN id
  kind              text NOT NULL DEFAULT 'chat'   -- 'chat' | 'image' | ...
  provider          text NOT NULL DEFAULT ''
  model             text NOT NULL DEFAULT ''
  input_tokens      integer NOT NULL DEFAULT 0
  output_tokens     integer NOT NULL DEFAULT 0
  total_tokens      integer NOT NULL DEFAULT 0
  cost_usd          numeric(16,10) NOT NULL DEFAULT 0
  duration_ms       integer NOT NULL DEFAULT 0
  created_at        timestamptz NOT NULL DEFAULT now()

usage_requests
  username          text NOT NULL
  day               date NOT NULL
  count             integer NOT NULL DEFAULT 0
  PRIMARY KEY (username, day)
```

> **`username` means different things in different tables.** `usage_messages.username` is
> the login id (`rems.baks`); `conversations.username` and `messages.username` hold the
> **display** name (`rems baks`). Joins between `users` and the other two will silently
> return nothing. Join on `conversations.session_id = usage_messages.session_id` instead,
> or normalise with `replace(username, ' ', '.')` as a last resort.

> **`[ended session]` is a real row.** `messages.role = 'system'` with
> `content = '[ended session]'` marks where a conversation ended. It is a load-bearing
> wire value — the widget renders it as a divider, and the dashboard's per-session cost
> splits on it. Deleting one merges two sessions and changes every cost figure downstream.

Sequences (`messages_id_seq`, `usage_messages_id_seq`) back the `BIGSERIAL` ids. `id` is
the transcript pagination cursor, so **do not reset or renumber `messages.id`** — history
paging is built on it.

---

## Users

### Read

```sql
-- Everyone
SELECT username, display_name, department, role, enabled, last_seen
FROM users ORDER BY last_seen DESC NULLS LAST;

-- One person
SELECT * FROM users WHERE username = 'remiel.baking';

-- Admins only
SELECT username, display_name, last_seen FROM users WHERE role = 'admin';

-- Never seen, or stale
SELECT username, created_at FROM users
WHERE last_seen IS NULL OR last_seen < now() - interval '90 days';
```

### Create

`ensureUser` in the application upserts on first login, so this is only for pre-seeding.

```sql
INSERT INTO users (username, display_name, department, role, enabled, requests_per_day)
VALUES ('remiel.baking', 'Remiel Baking', 'MIS', 'user', true, 100)
ON CONFLICT (username) DO UPDATE SET
  display_name     = EXCLUDED.display_name,
  department       = EXCLUDED.department,
  requests_per_day = EXCLUDED.requests_per_day,
  updated_at       = now();
```

### Update

```sql
-- Promote to admin
UPDATE users SET role = 'admin', updated_at = now() WHERE username = 'remiel.baking';

-- Per-user quota override. NULL means "inherit the server default" and is NOT the
-- same as 0 - 0 blocks the user outright, NULL hands them the default.
UPDATE users SET requests_per_day = 250 WHERE username = 'remiel.baking';
UPDATE users SET requests_per_day = NULL WHERE username = 'remiel.baking';   -- back to default

-- Upload cap (bytes). NULL inherits, same distinction as above.
UPDATE users SET max_upload_bytes = 26214400 WHERE username = 'remiel.baking';

-- Disable without deleting: keeps history and stops access
UPDATE users SET enabled = false, updated_at = now() WHERE username = 'remiel.baking';

-- Touch last_seen (the app does this on every chat turn)
UPDATE users SET last_seen = now() WHERE username = 'remiel.baking';

-- Free-text note
UPDATE users SET note = 'Contractor — expires 2026-12-31' WHERE username = 'remiel.baking';
```

### Delete

```sql
-- Check what depends on this user first
SELECT count(*) AS conversations FROM conversations WHERE username = 'Remiel Baking';
SELECT count(*) AS usage_rows    FROM usage_messages  WHERE username = 'remiel.baking';
SELECT count(*) AS counters      FROM usage_requests  WHERE username = 'remiel.baking';

-- Full removal: counters first (they reference users), then the user.
-- Conversations, messages and usage are intentionally LEFT ALONE - the transcript and
-- the cost record outlive the account.
BEGIN;
DELETE FROM usage_requests WHERE username = 'remiel.baking';
DELETE FROM users          WHERE username = 'remiel.baking';
COMMIT;
```

---

## Conversations

### Read

```sql
-- All conversations, most recently active first
SELECT session_id, username, mode, status, message_count,
       created_at, last_message_at
FROM conversations
ORDER BY COALESCE(last_message_at, updated_at) DESC;

-- One conversation with its transcript
SELECT id, role, created_at, content
FROM messages
WHERE session_id = 'rems.baks'
ORDER BY id;                     -- id is the cursor; ascending = chronological

-- Active conversations only
SELECT session_id, username, last_message_at FROM conversations
WHERE status = 'active' ORDER BY last_message_at DESC;

-- How many ended sessions each conversation holds
SELECT c.session_id,
       count(*) FILTER (WHERE m.content = '[ended session]') AS ended_sessions
FROM conversations c
JOIN messages m ON m.session_id = c.session_id
GROUP BY c.session_id ORDER BY c.session_id;
```

### Create

Rare. Normally created by the first `/api/chat` turn.

```sql
INSERT INTO conversations (session_id, username, mode, status)
VALUES ('manual-2026-10-08-a', 'Remiel Baking', 'chat', 'active');
```

### Update

```sql
-- Close a session without going through the idle timer. The transcript is preserved;
-- append the marker yourself if you want the divider to render.
UPDATE conversations SET status = 'ended', updated_at = now()
WHERE session_id = 'rems.baks';

-- Hand-write the end marker (what expireIfIdle normally does)
INSERT INTO messages (session_id, username, role, content)
VALUES ('rems.baks', 'Remiel Baking', 'system', '[ended session]');

-- Force the mode
UPDATE conversations SET mode = 'escalated' WHERE session_id = 'rems.baks';

-- Repair a drifted message_count from the actual rows
UPDATE conversations c
SET message_count = (
  SELECT count(*) FROM messages m
  WHERE m.session_id = c.session_id AND m.role <> 'system'
)
WHERE c.session_id = 'rems.baks';

-- Touch activity
UPDATE conversations
SET last_message_at = now(), updated_at = now()
WHERE session_id = 'rems.baks';

-- Attach an external control number
UPDATE conversations SET control_number = 'SRF-2026-0042' WHERE session_id = 'rems.baks';

-- Stash ticket-intake state
UPDATE conversations
SET state = state || '{"intake_stage":"awaiting_problem"}'::jsonb
WHERE session_id = 'rems.baks';
```

### Delete

```sql
-- Preview the blast radius
SELECT
  (SELECT count(*) FROM messages       WHERE session_id = 'rems.baks') AS messages,
  (SELECT count(*) FROM usage_messages WHERE session_id = 'rems.baks') AS usage_rows;

-- Delete the conversation but KEEP the transcript and the cost record.
-- This is what DELETE /api/admin/conversations/:id does.
BEGIN;
DELETE FROM messages       WHERE session_id = 'rems.baks';
DELETE FROM conversations  WHERE session_id = 'rems.baks';
COMMIT;

-- Delete everything including usage. Irreversible and it changes historical cost
-- totals, so confirm the reporting requirement first.
BEGIN;
DELETE FROM usage_messages WHERE session_id = 'rems.baks';
DELETE FROM messages       WHERE session_id = 'rems.baks';
DELETE FROM conversations  WHERE session_id = 'rems.baks';
COMMIT;

-- Everything, no WHERE clause. Read it twice.
BEGIN;
DELETE FROM messages; DELETE FROM conversations;
COMMIT;
```

---

## Messages

### Read

```sql
-- Newest 20, matching what the widget requests first
SELECT id, role, created_at, left(content, 120) AS preview
FROM messages WHERE session_id = 'rems.baks'
ORDER BY id DESC LIMIT 20;

-- Page backwards with the cursor (this is exactly how pageMessages works)
SELECT id, role, content FROM messages
WHERE session_id = 'rems.baks' AND id < 12345
ORDER BY id DESC LIMIT 20;

-- Jump to a point in time
SELECT id, role, created_at, content FROM messages
WHERE session_id = 'rems.baks'
  AND created_at BETWEEN '2026-10-07 02:00:00+00' AND '2026-10-07 03:00:00+00'
ORDER BY id;

-- Full-text search across transcripts
SELECT session_id, username, created_at, left(content, 200)
FROM messages
WHERE content ILIKE '%printer%'
ORDER BY created_at DESC LIMIT 50;

-- Messages carrying file records (assistant turns the model actually read)
SELECT id, session_id, created_at, meta
FROM messages
WHERE meta ? 'files'
ORDER BY id DESC LIMIT 50;
```

### Create

```sql
-- A user turn
INSERT INTO messages (session_id, username, role, content)
VALUES ('rems.baks', 'rems baks', 'user', 'my printer is offline')
RETURNING id;

-- An assistant turn that consumed a file. This is the record the dashboard's
-- Files column reads, so keep the same shape stage.escalate writes.
INSERT INTO messages (session_id, username, role, content, meta)
VALUES (
  'rems.baks', 'rems baks', 'assistant', 'The image shows a paper jam…',
  '{"files":[{"name":"photo.jpg","stored_name":"abc123_photo.jpg",
              "type":"image/jpeg","size":11576}]}'::jsonb
);

-- Backfill meta for an assistant turn that did read a file but predates tracking
UPDATE messages
SET meta = jsonb_set(meta, '{files}',
  '[{"name":"photo.jpg","stored_name":"abc123_photo.jpg","type":"image/jpeg","size":11576}]'::jsonb)
WHERE id = 991;

-- The end-of-session marker
INSERT INTO messages (session_id, username, role, content)
VALUES ('rems.baks', 'Remiel Baking', 'system', '[ended session]');
```

### Update

```sql
-- Redact or correct content
UPDATE messages SET content = '[redacted]'
WHERE id = 991 AND role = 'user';

-- Move a message to another conversation
UPDATE messages SET session_id = 'rems.baks'
WHERE id = 991;

-- Fix a mislabelled role
UPDATE messages SET role = 'assistant' WHERE id = 992;

-- Merge content
UPDATE messages SET content = content || E'\n\n(edited)'
WHERE id = 991;

-- Strip every file record, e.g. to make a session report 0 files
UPDATE messages SET meta = meta - 'files'
WHERE session_id = 'rems.baks' AND meta ? 'files';

-- Backdate or re-date a message
UPDATE messages SET created_at = '2026-10-07 02:00:00+00' WHERE id = 991;
```

> Re-dating a message can move which **session** it belongs to, because sessions are cut
> on timestamps. Fixing a bad timestamp may therefore change per-session cost figures, not
> just their order.

### Delete

```sql
-- Preview
SELECT id, role, created_at, left(content, 80) FROM messages WHERE id = 991;

-- One message
DELETE FROM messages WHERE id = 991;

-- Everything after a point — removes a runaway tail
DELETE FROM messages
WHERE session_id = 'rems.baks' AND id > 990;

-- Remove every marker in one conversation, MERGING all its sessions into one.
-- Costs will re-attribute, so do not do this casually.
DELETE FROM messages
WHERE session_id = 'rems.baks' AND role = 'system' AND content = '[ended session]';

-- Strip system rows only, leaving the human/assistant dialogue intact
DELETE FROM messages WHERE role = 'system';
```

---

## Usage ledger

`usage_messages` is the financial record. It is never pruned by the application and
should never be deleted to "clean up" — that silently rewrites history.

### Read

```sql
-- All calls for a conversation
SELECT id, kind, model, input_tokens, output_tokens, cost_usd, duration_ms, created_at
FROM usage_messages WHERE session_id = 'rems.baks' ORDER BY created_at;

-- Per-user totals, all time
SELECT username,
       count(*)                     AS calls,
       sum(input_tokens)            AS input_tokens,
       sum(output_tokens)           AS output_tokens,
       round(sum(cost_usd), 8)      AS cost_usd
FROM usage_messages
GROUP BY username ORDER BY cost_usd DESC;

-- Per day
SELECT created_at::date AS day, count(*) AS calls,
       sum(total_tokens) AS tokens, round(sum(cost_usd), 8) AS cost
FROM usage_messages
WHERE created_at >= now() - interval '30 days'
GROUP BY 1 ORDER BY 1 DESC;

-- By model
SELECT model, provider, count(*) AS calls,
       round(sum(cost_usd), 8) AS cost
FROM usage_messages GROUP BY model, provider ORDER BY cost DESC;

-- Vision / non-chat calls, which are costed separately from conversations
SELECT kind, count(*) AS calls, round(sum(cost_usd), 8) AS cost
FROM usage_messages WHERE kind <> 'chat' GROUP BY kind;

-- Per-conversation input token total (the basis for per-session cost)
SELECT session_id, sum(input_tokens) AS input, sum(output_tokens) AS output
FROM usage_messages GROUP BY session_id ORDER BY session_id;
```

### Create

Normally written by `recordMessage` during a chat turn. Manual insertion is for fixing a
missed call — and a fabricated row becomes a real cost figure.

```sql
INSERT INTO usage_messages
  (session_id, username, kind, provider, model,
   input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at)
VALUES
  ('rems.baks', 'rems.baks', 'chat', 'gemini', 'gemini-3.5-flash-lite',
   2100, 91, 2191, 0.0002285, 2340, now())
RETURNING id;
```

### Update

```sql
-- Correct a model name (typo, or a model rename)
UPDATE usage_messages SET model = 'gemini-3.5-flash-lite'
WHERE id = 42 AND model = 'gemini-3.5-flash-litee';

-- Correct a misattributed conversation or user
UPDATE usage_messages SET session_id = 'remiel.baking' WHERE id = 42;
UPDATE usage_messages SET username = 'remiel.baking' WHERE id = 42;

-- Recompute total_tokens where it drifted from its parts
UPDATE usage_messages SET total_tokens = input_tokens + output_tokens
WHERE total_tokens <> input_tokens + output_tokens;

-- Re-price a period at a fixed rate ($0.30/1M in, $2.50/1M out)
UPDATE usage_messages
SET cost_usd = round((input_tokens * 0.30 + output_tokens * 2.50) / 1000000, 10)
WHERE created_at >= '2026-10-01' AND created_at < '2026-11-01';
```

> `cost_usd` is `numeric(16,10)` — ten decimal places. The dashboard's IT/OT costs are a
> separate, admin-configurable rating of the same tokens, and both are reported. Editing
> `cost_usd` changes only the Ledger figure.

### Delete

```sql
-- Delete duplicates that a retried write created
DELETE FROM usage_messages WHERE id = 43;

-- Remove obviously double-billed rows (same session, model, tokens, second apart)
DELETE FROM usage_messages a
USING usage_messages b
WHERE a.id > b.id
  AND a.session_id = b.session_id
  AND a.model = b.model
  AND a.input_tokens = b.input_tokens
  AND a.output_tokens = b.output_tokens
  AND a.created_at - b.created_at < interval '5 seconds';

-- Remove a whole period (changes historical reporting)
DELETE FROM usage_messages WHERE created_at < '2026-01-01';

-- Vacate space without touching data
VACUUM FULL usage_messages;
```

---

## Request counters

Daily per-user request counts backing the `requests_per_day` cap.

### Read

```sql
SELECT * FROM usage_requests
WHERE username = 'remiel.baking' AND day = CURRENT_DATE;

-- Today, everyone
SELECT username, count
FROM usage_requests WHERE day = CURRENT_DATE ORDER BY count DESC;

-- Who is near their cap
SELECT r.username, r.count, r.count * 0 + COALESCE(u.requests_per_day, 100) AS limit
FROM usage_requests r
LEFT JOIN users u ON u.username = r.username
WHERE r.day = CURRENT_DATE
ORDER BY r.count DESC LIMIT 10;
```

### Create / update

```sql
-- Increment (what a chat turn does)
INSERT INTO usage_requests (username, day, count)
VALUES ('remiel.baking', CURRENT_DATE, 1)
ON CONFLICT (username, day) DO UPDATE SET count = usage_requests.count + 1;

-- Set an absolute value (backfill, or undo a double count)
INSERT INTO usage_requests (username, day, count)
VALUES ('remiel.baking', CURRENT_DATE, 1)
ON CONFLICT (username, day) DO UPDATE SET count = EXCLUDED.count;

-- Zero today's count — the "unblock this user" action
UPDATE usage_requests SET count = 0
WHERE username = 'remiel.baking' AND day = CURRENT_DATE;
```

### Delete

```sql
-- Reset one day
DELETE FROM usage_requests WHERE username = 'remiel.baking' AND day = CURRENT_DATE;

-- Reset everyone today
DELETE FROM usage_requests WHERE day = CURRENT_DATE;

-- Drop history older than 90 days (safe: it is a rolling counter)
DELETE FROM usage_requests WHERE day < CURRENT_DATE - 90;
```

---

## Reporting queries

These mirror what the dashboard shows, and are the quickest way to check its arithmetic.

### Tokens and cost per user, last 30 days

```sql
SELECT u.username, u.display_name,
       count(um.id)              AS calls,
       coalesce(sum(um.input_tokens), 0)  AS input_tokens,
       coalesce(sum(um.output_tokens), 0) AS output_tokens,
       round(coalesce(sum(um.cost_usd), 0), 8) AS ledger_cost,
       round((coalesce(sum(um.input_tokens),0)  * 0.30
            + coalesce(sum(um.output_tokens),0) * 2.50) / 1000000, 6) AS rated_cost
FROM users u
LEFT JOIN usage_messages um
       ON um.username = u.username
      AND um.created_at >= now() - interval '30 days'
GROUP BY u.username, u.display_name
ORDER BY rated_cost DESC;
```

### Per-session cost (the dashboard's Per Session Cost, by hand)

A session runs from a conversation start, or from just after the previous end marker,
through to the next marker. This attributes usage to the last session that had already
started when the call was made:

```sql
WITH segments AS (
  SELECT c.session_id,
         min(m.created_at) FILTER (WHERE m.role <> 'system') AS started,
         max(m.created_at) FILTER (WHERE m.role <> 'system') AS ended
  FROM conversations c
  JOIN messages m ON m.session_id = c.session_id
  GROUP BY c.session_id
),
usage AS (
  SELECT session_id, sum(input_tokens) AS i, sum(output_tokens) AS o
  FROM usage_messages GROUP BY session_id
)
SELECT s.session_id,
       s.started, s.ended,
       u.i AS input_tokens, u.o AS output_tokens,
       round((coalesce(u.i,0) * 0.30 + coalesce(u.o,0) * 2.50) / 1000000, 6) AS rated_cost
FROM segments s
LEFT JOIN usage u ON u.session_id = s.session_id
ORDER BY s.started;

-- Must reconcile exactly. If these two disagree, attribution has drifted.
SELECT sum(input_tokens) AS ledger_input, sum(output_tokens) AS ledger_output
FROM usage_messages;
```

### Free-text search across all transcripts

```sql
SELECT m.session_id, m.username, m.created_at, left(m.content, 150) AS excerpt
FROM messages m
WHERE m.role = 'user' AND m.content ILIKE '%cannot connect%'
ORDER BY m.created_at DESC LIMIT 100;
```

### Conversations by state

```sql
SELECT state->>'intake_stage' AS stage, count(*)
FROM conversations
WHERE state <> '{}'::jsonb
GROUP BY 1 ORDER BY 2 DESC;
```

---

## Maintenance

### Storage

```sql
SELECT pg_size_pretty(pg_database_size(current_database()))  AS database_size;

SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS total,
       n_live_tup AS rows
FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC;

VACUUM ANALYZE;          -- ordinary, safe, run any time
VACUUM FULL users;       -- reclaims space, locks the table
REINDEX INDEX idx_messages_session_id_desc;
```

### Health

```sql
-- Connections
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active') AS active,
       count(*) FILTER (WHERE state = 'idle')   AS idle
FROM pg_stat_activity WHERE datname = current_database();

-- Longest running query
SELECT pid, now() - query_start AS runtime, left(query, 120)
FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 seconds'
ORDER BY runtime DESC;

-- Table bloat / dead rows
SELECT relname, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC;

-- Sequence positions (compare against max(id) to spot drift)
SELECT last_value FROM messages_id_seq;
SELECT max(id) FROM messages;
```

### Retention

The application prunes message **bodies** older than 180 days on a daily schedule and
never prunes `usage_messages`. To run it by hand:

```sql
-- Preview first
SELECT count(*) FROM messages WHERE created_at < now() - interval '180 days';

DELETE FROM messages WHERE created_at < now() - interval '180 days';
```

Rolling the counters is safe at any time:

```sql
DELETE FROM usage_requests WHERE day < CURRENT_DATE - 90;
```

### Sequences

Only if `id` has drifted badly ahead of the real rows, which should not happen:

```sql
SELECT setval('messages_id_seq',
              (SELECT coalesce(max(id), 1) FROM messages));
```

> Do not reset this casually. `messages.id` is the history pagination cursor; renumbering
> breaks paging and every `id > N` bulk operation you have ever written against it.

---

## Export and restore

### Export

```bash
# Everything
docker compose exec -T postgres pg_dump -U ami_helpdesk -d ami_helpdesk > full.sql

# Schema only — the useful thing to commit alongside db/schema.sql
docker compose exec -T postgres pg_dump -U ami_helpdesk -d ami_helpdesk --schema-only > schema-only.sql

# Just the ledger, for finance
docker compose exec -T postgres pg_dump -U ami_helpdesk -d ami_helpdesk \
  -t usage_messages > usage.sql
```

Query results to CSV. **Use `\copy` (client-side), not `COPY`.** `COPY ... TO 'file'`
writes on the *server* into the container's filesystem, which is not your machine and,
as the postgres user, is often not writable — `COPY ... TO '/dev/stdout'` fails with
"Permission denied". `\copy` streams the result back through psql and lands wherever you
run it:

```sql
-- client-side: lands on YOUR machine, no server permissions needed
\copy (
  SELECT session_id, username, input_tokens, output_tokens, cost_usd, created_at
  FROM usage_messages ORDER BY created_at
) TO 'usage.csv' WITH (FORMAT csv, HEADER true)

\copy (
  SELECT username, count(*) AS calls, round(sum(cost_usd), 8) AS cost
  FROM usage_messages
  WHERE created_at >= now() - interval '30 days'
  GROUP BY username ORDER BY cost DESC
) TO '/tmp/usage-by-user.csv' WITH (FORMAT csv, HEADER true)

-- server-side: only if the postgres user can write that path
COPY (SELECT * FROM users) TO '/tmp/users.csv' WITH (FORMAT csv, HEADER true);
```

### Restore

```bash
docker compose stop ami-chatbot        # stop writes first
docker compose exec -T postgres psql -U ami_helpdesk -d ami_helpdesk -v ON_ERROR_STOP=1 < full.sql
docker compose start ami-chatbot
```

Restore a single table into a scratch database first if you intend to merge rather than
replace:

```bash
docker compose exec -T postgres createdb -U ami_helpdesk restore_test
docker compose exec -T postgres psql -U ami_helpdesk -d restore_test < usage.sql
```

---

## Related

- [`db/schema.sql`](../db/schema.sql) — the authoritative schema, applied on startup
- [`README.md`](../README.md) — architecture and per-session cost semantics
- [`docs/DEVELOPMENT.md`](DEVELOPMENT.md) — project layout and the dashboard build
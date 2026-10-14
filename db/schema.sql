-- Ami Helpdesk chatbot - PostgreSQL schema
--
-- This database is used by the chatbot ONLY. n8n keeps its own storage and is
-- never touched by this schema.
--
-- Applied automatically on startup by src/server/db.js and tracked in
-- schema_migrations, so re-running is safe. Every statement is idempotent.

-- ---------------------------------------------------------------------------
-- users
-- One row per person, keyed on the MIS login id (e.g. "remiel.baking") that the
-- helpdesk PHP passes from the authenticated session. That id is stable and
-- unique; the display name is not, and changes when someone is renamed.
--
-- requests_per_day / max_upload_bytes are NULL when the user has no override and
-- should inherit the server default. NULL never means "zero" - see the PATCH
-- handler, which distinguishes absent (leave alone) from null (clear override).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  username          TEXT PRIMARY KEY,
  display_name      TEXT        NOT NULL DEFAULT '',
  email             TEXT        NOT NULL DEFAULT '',
  department        TEXT        NOT NULL DEFAULT '',
  role              TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  requests_per_day  INTEGER     NULL CHECK (requests_per_day IS NULL OR requests_per_day >= 0),
  max_upload_bytes  BIGINT      NULL CHECK (max_upload_bytes IS NULL OR max_upload_bytes >= 0),
  note              TEXT        NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- conversations
-- Session-level state. Messages live in the messages table so a long
-- conversation can be paginated instead of loaded whole.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  session_id      TEXT PRIMARY KEY,
  username        TEXT        NOT NULL DEFAULT '',
  mode            TEXT        NOT NULL DEFAULT 'chat',
  status          TEXT        NOT NULL DEFAULT 'active',
  control_number  TEXT,
  uploads         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Transient ticket-intake state (collected_fields, intake_stage,
  -- pending_question, attachment_asked, ...). Persisted so a user who is
  -- halfway through the guided form does not lose their place on restart.
  state           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  message_count   INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conversations_username  ON conversations (username);
CREATE INDEX IF NOT EXISTS idx_conversations_recent    ON conversations (last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- messages
-- id is a monotonic BIGSERIAL and doubles as the pagination cursor: ask for
-- "messages before id X" to walk backwards through a long thread.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT        NOT NULL,
  username   TEXT        NOT NULL DEFAULT '',
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT        NOT NULL DEFAULT '',
  meta       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary access path: newest-first page for one session.
CREATE INDEX IF NOT EXISTS idx_messages_session_id_desc ON messages (session_id, id DESC);
-- Supports the retention sweep that prunes message bodies after 180 days.
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

-- ---------------------------------------------------------------------------
-- usage_messages
-- Per-call token and cost accounting. This is the financial record, so it is
-- kept forever and is never pruned - only message bodies above are.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_messages (
  id            BIGSERIAL PRIMARY KEY,
  session_id    TEXT        NOT NULL DEFAULT '',
  username      TEXT        NOT NULL DEFAULT '',
  kind          TEXT        NOT NULL DEFAULT 'chat',
  provider      TEXT        NOT NULL DEFAULT '',
  model         TEXT        NOT NULL DEFAULT '',
  input_tokens  INTEGER     NOT NULL DEFAULT 0,
  output_tokens INTEGER     NOT NULL DEFAULT 0,
  total_tokens  INTEGER     NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(16,10) NOT NULL DEFAULT 0,
  duration_ms   INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The admin dashboard groups by day, by user, by model and by session.
CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_messages (created_at);
CREATE INDEX IF NOT EXISTS idx_usage_username   ON usage_messages (username);
CREATE INDEX IF NOT EXISTS idx_usage_session    ON usage_messages (session_id);

-- ---------------------------------------------------------------------------
-- usage_requests
-- Daily request counters backing the per-user requests/day cap.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_requests (
  username TEXT NOT NULL,
  day      DATE NOT NULL,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (username, day)
);

-- ---------------------------------------------------------------------------
-- ticket_modal_config
-- Which ticket types the chatbot fills in itself, and where the rest are sent.
--
-- A type can be switched off without a deploy. When it is, the widget does not
-- open the form for it at all: the chat hands over a link to the real MIS form
-- instead, because a chatbot that renders a stale copy of a form MIS is free to
-- change is worse than one that admits it does not handle it.
--
-- external_url is NULL on purpose for an enabled type. "Enabled, no link" means
-- the chatbot fills the form in; "Disabled, no link" means the type cannot be
-- requested at all, and the widget says so rather than opening a dead form.
-- Both halves are stored as given - no URL rewriting, no path munging.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_modal_config (
  ticket_type  TEXT        PRIMARY KEY,
  enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
  external_url TEXT        NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seeded on every boot with ON CONFLICT DO NOTHING, so a row an admin has edited
-- is never overwritten on restart. Defaults ship every type ENABLED, which is
-- the behaviour this feature had before it existed.
--
-- The `_links_only` row is not a ticket type. It is the master switch: when on,
-- no type opens a form at all and every type is handed to the user as a link. It
-- lives in the same table so there is one place to look and one save to make,
-- and it is filtered out of every type list so it cannot be mistaken for a
-- fourth ticket type.
INSERT INTO ticket_modal_config (ticket_type, enabled, external_url) VALUES
  ('tech_support',   TRUE, NULL),
  ('system_request', TRUE, NULL),
  ('it_asset',       TRUE, NULL),
  ('_links_only',    FALSE, NULL)
ON CONFLICT (ticket_type) DO NOTHING;

-- ---------------------------------------------------------------------------
-- schema_migrations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

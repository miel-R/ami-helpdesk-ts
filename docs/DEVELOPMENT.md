# Development Guide

## Getting Started

### Prerequisites
- Node.js 18+
- pnpm or npm
- Docker & Docker Compose (for full stack)

### Setup
```bash
# Clone and install
git clone <repo>
cd ami-helpdesk-ts
npm ci

# Copy environment template
cp .env.example .env
# Edit .env with your values
```

### Development Commands

```bash
# TypeScript watch mode
npm run watch

# Build once
npm run build

# Run dev server (JSON fallback, no Postgres)
npm run dev

# Run with Postgres (docker compose)
docker compose up -d postgres
npm run dev

# Full stack with Docker
docker compose up -d --build

# Type checking
npm run typecheck
```

## Project Structure

```
src/
├── server/
│   ├── server.ts         # Entry: init storage, schedulers, listen, SIGTERM
│   ├── app.ts            # Express wiring only — middleware + route registration
│   ├── ai.ts             # AI clients (Gemini/OpenAI)
│   ├── controllers/      # HTTP layer, one file per route group
│   ├── services/         # The work. One concern per file.
│   │   ├── chat/         # a turn, as ordered stages
│   │   ├── ticket/       # payload building, n8n client, ticket routes
│   │   └── analytics-*.service.ts
│   ├── features/agent/   # Domain logic: escalation, intent, prompts, commands
│   ├── db/               # StorageBackend contract + PG and JSON backends
│   ├── config/           # config.service.ts, cost-rates.service.ts
│   ├── models/           # types.model.ts, analytics.model.ts
│   └── core/             # logger, counters
├── dashboard/            # Admin dashboard SOURCE
│   ├── main.ts           # Tab router, global filter, admin auth
│   ├── api.ts  utils.ts  modal.ts  types.ts
│   └── tabs/             # overview, trends, costs, users, sessions,
│                         # realtime, inspect, user-admin, rates
├── types.ts              # Shared widget types
├── public/
│   ├── widget/           # Widget ES modules (hand-written, not built)
│   └── Dashboard/        # Dashboard OUTPUT — index.html + compiled js
├── rag/                  # Few-shot examples for AI
├── db/schema.sql         # PostgreSQL schema
├── tools/                # Regression tests
└── data/                 # JSON fallback storage + cost-rates.json
```

`npm run build` compiles both tsconfigs: `tsconfig.json` → `dist/` (server) and
`tsconfig.dashboard.json` → `public/Dashboard/js/` (dashboard). **Treat
`public/Dashboard/` as build output** — edit `src/dashboard/` instead. Since `./public`
is bind-mounted read-only into the container, dashboard changes are live on browser refresh;
`dist/` changes need `docker compose up -d --build`.

## Key Concepts

### Conversation Flow

```
User Message → /api/chat
    → Auth (loginUser + identityToken)
    → Role Resolution (token → MIS dir → DB → ADMIN_USERS)
    → Quota Check
    → Idle Expiry Check (nudge/expire)
    → File Upload (if any)
    → AI Call (Gemini → OpenAI fallback)
    → AI Reply Processing
    │   ├── Sanitize (fabricated tickets, UI hallucinations)
    │   ├── Ticket Request Check (regular users blocked)
    │   └── Admin Commands ($help, $reset, etc.)
    → Save Message + AI Reply
    → Return Response
```

### Role Resolution Priority

```typescript
// In src/server/services/identity.service.ts
resolveRole({
  loginId,           // From widget
  dbRole,            // From users table
  identityToken,     // Signed JWT from MIS PHP
  secret,            // IDENTITY_SECRET
  allowlist,         // ADMIN_USERS from .env
  directoryRole      // From MIS DB (scrf_user)
})

// Priority: token → MIS directory → DB → ADMIN_USERS → 'user'
```

### AI Integration

- **Primary**: Google Gemini (`gemini-3.5-flash-lite`)
- **Fallback**: OpenAI (`gpt-4o-mini`) - only when Gemini key missing
- **System Prompt**: `src/server/app.ts` → `SYSTEM_PROMPT`
- **Few-shot**: `src/server/services/rag.service.ts` loads examples from `rag/*.json`
- **Cost Tracking**: Per-message token usage + USD cost in `usage.json`

### Session Management

```typescript
// Conversation type (src/server/models/types.model.ts)
interface Conversation {
  session_id: string;
  user: SessionUser;
  messages: Message[];           // Last 20 in memory, full in DB
  mode: 'chat' | 'escalated';    // No more 'intake'/'confirm'
  status: 'active' | 'ended' | 'escalated';
  last_control_number?: string;
  pending_goodbye?: string;
  greeted?: boolean;
  nudge_sent?: boolean;          // For 2-stage idle
  uploads?: unknown[];
  created_at?: string;
  updated_at?: string;
}
```

### Idle Expiry (2-Stage)

```typescript
// config.ts
sessionTimeout: 5 minutes      // SESSION_TIMEOUT_MINUTES
nudgeAfter: 4 minutes          // SESSION_NUDGE_MINUTES

// utils.ts → expireIfIdle()
if (idleMs >= sessionTimeout) {
  // Stage 2: Expire session, queue farewell
  return farewellText;
}
if (idleMs >= nudgeAfter && !nudge_sent) {
  // Stage 1: Send nudge, mark nudge_sent = true
  return "Still there? I'll close this chat in a minute...";
}
```

### Ticket Submission Flow

```
POST /api/ticket (multipart)
  → Validate required fields per type
  → Validate catalog fields (dept, location, category, system, item)
  → Validate quantity vs stock (IT Asset)
  → Process attachments
  → Build webhook payload
  → triggerWebhook() → n8n
  → n8n returns { success, control_number }
  → Return { ok: true, control_number }
```

### Database Schema (PostgreSQL)

```sql
-- conversations: one row per widget session
session_id (PK), username, mode, status, control_number,
uploads (JSONB array), state (JSONB), message_count,
created_at, updated_at, last_message_at

-- messages: the TRANSCRIPT
id (PK), session_id, username,
role ('user'|'assistant'|'system'),
content, meta (JSONB), created_at

-- usage_messages: the LEDGER, one row per AI call
id (PK), session_id, username, kind, provider, model,
input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at

-- users
username (PK), display_name, email, department, role,
enabled, requests_per_day, max_upload_bytes, note,
created_at, last_seen, updated_at

-- usage_requests: daily counters backing the per-user cap
username, day, count   (composite PK)
```

Three traps in this schema that have each cost real debugging time:

- **`messages` is not the ledger.** `db().listMessages()` returns `usage_messages` rows
  (`UsageEntry`), not transcript rows. Reading it as a transcript silently produces
  plausible numbers with no `[ended session]` markers in sight, so sessions never split.
  Transcript rows come from `db().pageMessages(sessionId, {...})`, which pages backwards
  on `id` and **clamps `limit` to 100** regardless of what you pass.
- **`username` means different things in different tables.** `usage_messages.username` is
  the login id (`rems.baks`); `conversations.username` and `messages.username` hold the
  **display** name (`rems baks`). Filtering sessions by login id through
  `listConversations({username})` returns zero rows.
- **`[ended session]` is a real `messages` row**, written by `expireIfIdle` when a
  conversation goes idle. It is `role='system'`, is filtered out of the model's replayed
  context, and is the boundary the per-session analytics splits on.
- **`created_at` comes back as a `Date`, not a string.** `String(date)` yields
  `"Thu Oct 08 2026 08:27:45 GMT+0800 (…)"`, and sorting those lexicographically compares
  **weekday names** — every Thursday row sorted ahead of every Wednesday one, so session #1
  came out as the newest. Run every timestamp through `tsOf()` (analytics-tables.service.ts)
  before comparing or sorting it. This also decides which usage row lands in which session,
  so the bug moved money around as well as reordering rows.

### JSON Fallback

When `DATABASE_URL` is empty or Postgres unreachable:
- `data/usage.json` - token ledger
- `data/users.json` - user profiles
- `data/conversations/*.json` - individual conversations

## Testing

### Test Structure

```bash
tools/
├── with-server.cjs         # Boots dist/ on a spare port, runs a harness, tears it down
├── widget-regress.mjs      # Widget UI tests (JSDOM)
├── analytics-regress.cjs   # Analytics API + dashboard shell tests
├── export-regress.cjs      # Exported file contents: headers, precision, quoting, filenames
├── identity-regress.cjs    # Role resolution tests
├── identity-signing-regress.cjs  # JWT signing tests
├── commands-regress.cjs    # Command handler tests
├── commands-e2e.cjs        # Full HTTP e2e tests
├── domshim.mjs             # JSDOM wrapper
└── ami-identity-token.php  # PHP token generator
```

`with-server.cjs` exists because the harnesses speak plain HTTP while the deployed server
terminates HTTPS with a self-signed cert and has no HTTP listener. Run through it, the
analytics suite genuinely exercises the endpoints; run bare, it fails with
`ECONNREFUSED` and looks like a product regression when it is a harness bug.

### Running Tests

```bash
npm test                    # All tests
npm run test:widget         # Widget tests only
npm run test:export         # Exported file contents (no server needed)
npm run test:analytics     # Analytics API + dashboard
npm run test:identity       # Role resolution
npm run test:commands       # Commands
npm run test:e2e            # Full HTTP e2e
npm run test:modal          # Escalation marker, greeting, modal + ticket auth

Every suite runs against a SCRATCH data directory (set via `CONVERSATIONS_DIR`,
`ATTACHMENTS_DIR` and `UPLOADS_DIR`), with `DATABASE_URL` blank so it falls back
to JSON, and with no AI or webhook keys so it cannot spend tokens or file a real
ticket. If you add a suite that writes state, read its paths from
`config.paths` — `config.storage` looks like the override but nothing consumes it.
npm run typecheck           # TypeScript only
```

### Writing Tests

```javascript
// Pattern used in tools/*.cjs/.mjs
const ok = (name, condition, extra = '') => {
  if (condition) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};

// Async test
const response = await fetch(`${BASE}/api/chat`, { ... });
const data = await response.json();
ok('command works', data.reply.includes('expected text'), data.reply);
```

## Adding a New Ticket Type

1. **Add form definition** in `public/widget/modal.js` → `FORM_DEFINITIONS`
2. **Add required fields** in `src/server/services/ticket/routes.service.ts` → `REQUIRED_FIELDS`
3. **Add catalog validation** in `validateCatalogFields()` if new catalog fields
4. **Add webhook mapping** in `src/server/services/ticket/routes.service.ts` → `buildPayload()`
4. **Test**: `npm run build && npm test`

## Common Tasks

### Add a New Chat Command

1. Add to `ADMIN_COMMANDS` or `ALL_COMMANDS` in `src/server/features/agent/commands.ts`
2. Add handler in `handleCommand()`
3. Add test in `tools/commands-regress.cjs`

### Add a New Catalog Endpoint

1. Add function in `src/server/services/catalog.service.ts`
2. Add route in `src/server/services/ticket/routes.service.ts` (or new file)
3. Add to widget `modal.js` field `source`

### Modify AI Behavior

1. Edit `SYSTEM_PROMPT` in `src/server/features/agent/system-prompt.ts`
2. Add few-shot examples in `rag/*.json`
3. Test with `npm run test:commands` (includes AI retry tests)

### Add a Column to the Dashboard

1. Add the field to `AnalyticsSessionRow` (etc.) in **both** `src/server/models/analytics.model.ts`
   and `src/dashboard/types.ts` — they are duplicated on purpose so a server change cannot
   silently type-check against a stale browser type
2. Populate it in the relevant `src/server/services/analytics-*.service.ts`
3. Add a `<th>` to `public/Dashboard/index.html` **and** a matching `<td>` in the
   `sessionRows()` / `modelRows()` etc. in `src/dashboard/tabs/costs.ts`
4. Bump the `colspan` on the empty-state row — it is a hardcoded number and goes stale silently
5. `npm run build` (recompiles the dashboard into `public/Dashboard/js/`)
6. Add an assertion in `tools/analytics-regress.cjs`

**Check for duplicate element ids before you finish.** `getElementById` returns the first
match, so a duplicate makes a control silently inert rather than erroring. A duplicated
`usageUser` id once left the Costs user filter doing nothing while looking functional. The
regression harness fails on duplicate ids.

### Debug AI Calls

```bash
# Enable debug logging
DEBUG=ai:* npm run dev

# Check token usage
cat data/usage.json | jq '.entries | length'
```

### Verify Per Session Cost by Hand

The dashboard recomputes sessions from raw data on every request, so the API is enough to
audit it. Per-user sums must reconcile against the ledger exactly:

```bash
# 111673 / 1404 expected in this dataset
curl -sk -H "X-Admin-Key: admin" \
  'https://localhost:3000/api/analytics/sessions?limit=all' \
  | jq '[.sessions[].input_tokens] | add, [.sessions[].output_tokens] | add'

# Compare against the ledger
docker compose exec -T postgres psql -U ami_helpdesk -d ami_helpdesk \
  -c 'SELECT sum(input_tokens), sum(output_tokens) FROM usage_messages;'
```

If the two disagree, usage attribution has drifted — check that `assignUsage()` is charging
each row to the last session that had already started when the call was made.

## Docker Development

```bash
# Rebuild image after source changes
docker compose build ami-chatbot

# View logs
docker compose logs -f ami-chatbot

# Shell into container
docker compose exec ami-chatbot sh

# Run tests in container
docker compose exec ami-chatbot npm test
```

## Code Style

- **TypeScript**: Strict mode, no `any`, explicit types
- **No comments** unless explaining *why* (not *what*)
- **ES modules** in widget, CommonJS in server
- **Error handling**: Fail closed, log warnings, never crash chat

## Git Workflow

```bash
# Feature branch
git checkout -b feature/new-ticket-type

# Commit with conventional messages
git commit -m "feat: add facilities ticket type"

# Push and PR
git push origin feature/new-ticket-type
```
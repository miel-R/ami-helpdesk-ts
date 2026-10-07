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
│   ├── main.ts           # Express app, routes, chat handler
│   ├── routes/
│   │   └── ticket.ts     # POST /api/ticket
│   ├── catalog.ts        # MIS catalog endpoints
│   ├── webhook.ts        # n8n webhook client
│   ├── conversation.ts   # Session management + history
│   ├── ai.ts             # AI clients (Gemini/OpenAI)
│   ├── db.ts             # Storage (PG + JSON fallback)
│   ├── commands.ts       # $help, $reset, $list, etc.
│   ├── utils.ts          # Shared utilities
│   ├── types.ts          # TypeScript interfaces
│   ├── config.ts         # Configuration
│   └── routes/
├── public/
│   └── widget/
│       ├── main.js       # Widget entry, UI, events
│       ├── modal.js      # Ticket modal forms
│       ├── api.js        # Fetch wrapper
│       ├── state.js      # Widget state
│       ├── ui.js         # Rendering helpers
│       ├── config.js     # Widget config/constants
│       ├── icons.js      # SVG icons
│       └── events.js     # Event emitter
├── rag/                  # Few-shot examples for AI
├── db/schema.sql         # PostgreSQL schema
├── tools/                # Regression tests
└── data/                 # JSON fallback storage
```

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
-- conversations
session_id (PK), username, mode, status, control_number,
uploads, state (JSONB), message_count, created_at, updated_at

-- messages
id (PK), session_id, username, kind, provider, model,
input_tokens, output_tokens, total_tokens, cost_usd, duration_ms,
role, content, timestamp

-- users
username (PK), display_name, email, department, role,
enabled, requests_per_day, max_upload_bytes, note,
created_at, last_seen, updated_at

-- usage (ledger)
id, session_id, username, kind, provider, model,
input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at
```

### JSON Fallback

When `DATABASE_URL` is empty or Postgres unreachable:
- `data/usage.json` - token ledger
- `data/users.json` - user profiles
- `data/conversations/*.json` - individual conversations

## Testing

### Test Structure

```bash
tools/
├── widget-regress.mjs      # Widget UI tests (JSDOM)
├── analytics-regress.cjs   # Analytics API + dashboard shell tests
├── identity-regress.cjs    # Role resolution tests
├── identity-signing-regress.cjs  # JWT signing tests
├── commands-regress.cjs    # Command handler tests
├── commands-e2e.cjs        # Full HTTP e2e tests
├── domshim.mjs             # JSDOM wrapper
└── ami-identity-token.php  # PHP token generator
```

### Running Tests

```bash
npm test                    # All tests
npm run test:widget         # Widget tests only
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

1. Edit `SYSTEM_PROMPT` in `src/server/app.ts`
2. Add few-shot examples in `rag/*.json`
3. Test with `npm run test:commands` (includes AI retry tests)

### Debug AI Calls

```bash
# Enable debug logging
DEBUG=ai:* npm run dev

# Check token usage
cat data/usage.json | jq '.entries | length'
```

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
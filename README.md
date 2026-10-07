# Ami Helpdesk - TypeScript Version

A modern, AI-powered helpdesk chatbot for Amertron Corporation's MIS department. Built with TypeScript, Express, and Google Gemini AI.

## Features

- **AI-Powered Troubleshooting** - Google Gemini handles tech support questions naturally
- **Assistant-Driven Escalation** - The assistant opens the ticket form itself once it cannot resolve the issue. There is no "Create Ticket" button to hunt for.
- **Modal Ticket Creation** - Clean modal forms replace chat-based intake
- **Three Ticket Types** - Tech Support, System Request, IT Asset
- **Role-Based Access** - Admin commands, forged role protection
- **Session Management** - Idle nudge at 4 minutes, conversation closes at 5
- **Attachment Support** - File uploads with tickets
- **Admin Dashboard** - Usage stats, conversation history, cost tracking

## How Escalation Works

Ami troubleshoots first. Ticket capture is not something the user goes looking
for; the assistant decides when the chat has run out of road and hands over.

1. The model ends its reply with the marker `[[OPEN_TICKET_MODAL]]`, on its own
   line, when it genuinely cannot solve the problem.
2. The server strips the marker before the reply is sent or stored, and decides
   whether to set `open_ticket_modal: true` on the `/api/chat` response. The user
   never sees the token, and it never enters the transcript.
3. The widget opens the modal after the reply renders, so the user reads why the
   form appeared.
4. A marker with no other text in the reply is treated as noise and ignored.

**Who can open it.** An admin can simply order it: "create a ticket" opens the
form at once, with no triage, because they know what they are doing. A regular
user asking for a ticket does not get the form — asking is not a problem
statement. Ami asks what is wrong, does its quick basic checks, and opens the form
itself only once the problem is real and the basics did not settle it. The role
comes from the server-side session, never from the request body.

**The form opens already filled.** When it does open, `/api/chat` also returns
`ticket_prefill`, built from the substantive turns of the session, so the user
confirms what they already said instead of retyping it. Justification is left
blank on purpose: it is the user's judgement about why MIS should act.

See `docs/FLOW_DATA.md` for the full per-role decision table.

`POST /api/ticket` and the `/api/catalog/*` endpoints all require the
`X-Session-ID` header. The server resolves the caller from the conversation it
already has on file and reads the user details back out of its own user table, so
nothing about who is filing is taken from the request body.

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Google Gemini API key
- (Optional) PostgreSQL server - if not using, the app will use JSON fallback storage
- (Optional) N8N webhook URL for ticket creation
- (Optional) NAS storage for attachments (if using file attachments)

### Local Development
```bash
# Install dependencies
npm ci

# Build TypeScript
npm run build

# Start development server (uses JSON fallback, no Postgres needed)
npm run dev
```

### Docker (Production)
```bash
# 1. Copy and configure environment
cp .env.example .env

# 2. Edit .env with your configuration:
#    - GEMINI_API_KEY: Your Google Gemini API key (required)
#    - N8N_WEBHOOK_URL: Your n8n webhook URL for ticket creation (required for ticket submission)
#    - DATABASE_URL: PostgreSQL connection string (optional - if omitted, uses JSON fallback)
#    - POSTGRES_PASSWORD: If using PostgreSQL
#    - ADMIN_KEY: Admin dashboard access key (optional but recommended)
#    - ADMIN_USERS: Comma-separated list of admin usernames (optional)
#    - IDENTITY_SECRET: Secret for signing identity tokens (optional)
#    - MIS_DB_*: MIS database connection details for catalog lookups (optional)
#    - SESSION_*_MINUTES: Session timeout and nudge settings (optional)
#    - MAX_FILE_SIZE: Maximum upload size in bytes (default: 10MB)
#    - TIMEZONE: Timezone for timestamps (default: Asia/Manila)

# 3. For production attachment storage (if using NAS):
#    - Mount your NAS file_master directory on the host first:
#      sudo mkdir -p /mnt/nas/file_master
#      sudo mount -t nfs4 your-nas-server:/volume1/file_master /mnt/nas/file_master
#    - Then uncomment and adjust these lines in docker-compose.yml:
#      - ATTACHMENTS_DIR=/app/attachments
#      volumes:
#        - /mnt/nas/file_master:/app/attachments
#    - And make sure the n8n container has the same mount:
#      volumes:
#        - /mnt/nas/file_master:/app/attachments

# 4. Start all services
docker compose up -d --build

# 5. Verify the services are running
docker compose ps

# 6. View logs
#    Follow logs in real-time:
docker compose logs -f ami-chatbot
#    View logs for a specific service:
docker compose logs -f postgres
#    Get recent logs (last 100 lines):
docker compose logs --tail=100 ami-chatbot

# 7. Access the application:
#    - Chatbot widget: Available at your configured domain
#    - Admin dashboard: http://localhost:3000/admin.html
#    - Health check: http://localhost:3000/api/health

# 8. To stop and remove containers (preserves volumes):
docker compose down

# 9. To stop but preserve containers and volumes (for faster restart):
docker compose stop

# 10. To restart stopped containers:
docker compose start

# 11. To restart running containers (useful after config changes):
docker compose restart

# 12. To update to a new version:
#    a. Pull the latest changes from repository
#    git pull origin main
#    b. Rebuild and restart services
docker compose up -d --build
#    c. Or if you only changed configuration and not code:
docker compose up -d

# 13. To view stored data (conversations, attachments):
#     The data is stored in Docker volumes named:
#     - ami-helpdesk-node_ami_data (conversations, attachments, uploads)
#     - ami-helpdesk-node_ami_pgdata (PostgreSQL data)
#     You can back up these volumes using:
#     docker run --rm \
#       -v ami-helpdesk-node_ami_data:/volume \
#       -v $(pwd)/backup:/backup \
#       ubuntu tar czf /backup/ami-data-backup.tar.gz -C /volume . 
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Ami Helpdesk                           │
├─────────────────────────────────────────────────────────────┤
│  Frontend (Widget)                                          │
│  ├── Chat Interface (Gemini AI)                            │
│  ├── Modal Ticket Forms (3 types)                          │
│  │   ├── Tech Support                                     │
│  │   ├── System Request                                   │
│  │   └── IT Asset                                         │
│  └── History with Pagination (50 per page)                │
├─────────────────────────────────────────────────────────────┤
│  Backend (Express + TypeScript)                            │
│  ├── /api/chat          - AI conversation                  │
│  ├── /api/ticket        - Single-call ticket submission    │
│  ├── /api/catalog/*     - Dropdown options (MIS)           │
│  ├── /api/session       - Auth + history bootstrap         │
│  ├── /api/admin/*       - Dashboard endpoints              │
│  └── /api/health        - Health check                     │
├─────────────────────────────────────────────────────────────┤
│  Data Layer                                                 │
│  ├── PostgreSQL (primary) / JSON fallback                  │
│  ├── MIS Catalogs (departments, locations, systems, etc.)  │
│  └── File Storage (attachments)                            │
└─────────────────────────────────────────────────────────────┘
```

## Ticket Types & Fields

### Tech Support
| Field | Type | Required | Source |
|-------|------|----------|--------|
| Department | Select | Yes | MIS |
| Location | Search | Yes | MIS |
| Category | Select | Yes | MIS |
| System | Multi-select | Yes | MIS |
| Description | Textarea | Yes | - |
| Justification | Textarea | Yes | - |

### System Request
| Field | Type | Required | Source |
|-------|------|----------|--------|
| Department | Select | Yes | MIS |
| Category | Select | Yes | MIS |
| System | Select | Yes | MIS |
| Description | Textarea | Yes | - |
| Justification | Textarea | Yes | - |
| From Process | Textarea | Yes | - |
| To Process | Textarea | Yes | - |
| Risk | Textarea | Yes | - |

### IT Asset
| Field | Type | Required | Source |
|-------|------|----------|--------|
| Department | Select | Yes | MIS |
| Request Category | Select | Yes | Static |
| Item | Search | Yes | MIS |
| Quantity | Number | Yes | - |
| Description | Textarea | Yes | - |
| Justification | Textarea | Yes | - |

## API Endpoints

### Chat
- `POST /api/chat` - Main conversation endpoint
- `POST /api/session` - Bootstrap session + history

### Tickets
- `POST /api/ticket` - Submit complete ticket (multipart)

### Catalogs (for modal dropdowns)
All require the `X-Session-ID` header; unauthenticated calls get a 401.
- `GET /api/catalog/departments`
- `GET /api/catalog/locations`
- `GET /api/catalog/support-categories`
- `GET /api/catalog/request-categories`
- `GET /api/catalog/systems`
- `GET /api/catalog/asset-items`

### Admin
- `GET /api/admin/stats` - System statistics
- `GET /api/admin/users` - User list with token usage
- `GET /api/admin/conversations` - All conversations
- `GET /api/history/:sessionId` - Conversation history

### Health
- `GET /api/health` - Service status

## Widget Integration

```html
<script>
  window.AmiChatConfig = {
    baseUrl: 'https://your-domain.com',
    userName: 'John Doe',
    userEmail: 'john@company.com',
    userDepartment: 'IT',
    userRole: 'user',
    loginUser: 'john.doe',
    identityToken: 'signed-by-mis-php' // optional, for admin access
  };
</script>
<script src="https://your-domain.com/widget.js"></script>
```

## Admin Commands

| Command | Description | Admin Only |
|---------|-------------|------------|
| `$help` | Show available commands | No |
| `$whoami` | Show current user info | No |
| `$status` | Show session status | No |
| `$reset` | Clear conversation | No |
| `$end` | End session gracefully | No |
| `$list` | List conversations | Yes |
| `$diagnose` | System diagnostics | Yes |
| `$test-webhook` | Test n8n webhook | Yes |
| `$webhook-debug` | Toggle debug mode | Yes |
| `$disable` | Disable chatbot | Yes |
| `$enable` | Enable chatbot | Yes |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | - | Google Gemini API key |
| `GEMINI_MODEL` | No | `gemini-3.5-flash-lite` | Model to use |
| `OPENAI_API_KEY` | No | - | Fallback OpenAI key |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Fallback model |
| `N8N_WEBHOOK_URL` | Yes | - | Production n8n webhook |
| `N8N_TEST_WEBHOOK_URL` | No | - | Test webhook URL |
| `DATABASE_URL` | No | - | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | If using PG | - | Postgres password |
| `ADMIN_USERS` | No | - | Comma-separated admin logins |
| `ADMIN_KEY` | No | - | Admin dashboard key |
| `IDENTITY_SECRET` | No | - | JWT secret for signed tokens |
| `SESSION_TIMEOUT_MINUTES` | No | `5` | Session idle timeout |
| `SESSION_NUDGE_MINUTES` | No | `4` | Nudge warning time |
| `RATE_LIMIT_PER_DAY` | No | `10` | Tickets per user/day |
| `MAX_FILE_SIZE` | No | `10485760` | Max upload (bytes) |
| `TIMEZONE` | No | `Asia/Manila` | Ticket timestamp TZ |

## Project Structure

```
ami-helpdesk-ts/
├── src/server/
│   ├── server.ts            # Entry point: init storage, schedulers, listen, SIGTERM
│   ├── app.ts               # Express wiring only - middleware, route registration
│   ├── ai.ts                # Model client (Gemini / OpenAI)
│   ├── controllers/         # HTTP layer: translate request/response, no business logic
│   │   ├── chat.controller.ts       # /api/session, /api/chat
│   │   ├── history.controller.ts    # /api/history, /api/conversations
│   │   ├── users.controller.ts      # admin user CRUD
│   │   ├── dashboard.controller.ts  # /api/stats, /api/users, /api/logs
│   │   ├── usage.controller.ts      # cost + token reports
│   │   ├── health.controller.ts     # liveness and readiness
│   │   ├── files.controller.ts      # uploaded file serving
│   │   └── admin.shared.ts          # requireAdmin, wrap, intQuery
│   ├── services/            # The work. One concern per file.
│   │   ├── chat/            # a turn, as ordered stages (see below)
│   │   ├── ticket/          # payload building, n8n client, ticket routes
│   │   ├── session.service.ts       # conversation state + durable writes
│   │   ├── catalog.service.ts       # MIS catalog queries
│   │   ├── identity.service.ts      # role resolution
│   │   ├── quota.service.ts         # rate limits and per-user access
│   │   ├── rag.service.ts           # few-shot retrieval
│   │   ├── file.service.ts          # upload storage
│   │   └── session-lifecycle.service.ts   # idle expiry
│   ├── features/agent/      # Domain logic
│   │   ├── ticket-intake.ts         # which ticket type, and steering
│   │   ├── commands.ts              # slash commands
│   │   ├── escalation.ts            # when to hand over to the form
│   │   ├── intent.ts                # what the user is trying to say
│   │   ├── system-prompt.ts         # the instructions sent to the model
│   │   ├── prompt.ts                # per-turn identity context
│   │   └── greeting.ts              # opening and closing lines
│   ├── db/                  # One contract, two backends
│   │   ├── types.model.ts           # StorageBackend, the contract both implement
│   │   ├── postgres.backend.ts      # the real store
│   │   ├── json.backend.ts          # fallback, so a DB outage never takes chat down
│   │   ├── storage.service.ts       # which backend is active
│   │   └── helpers.ts
│   ├── core/                # logger, flags, filesystem helpers
│   ├── config/config.service.ts
│   └── models/types.model.ts
├── src/types.ts             # Shared widget types
├── public/widget/           # Browser-side ES modules
│   ├── main.js              # Widget entry point
│   ├── modal.js             # Ticket modal forms
│   ├── api.js  state.js  ui.js  config.js  icons.js
├── db/schema.sql            # PostgreSQL schema
├── tools/                   # Regression suites (see Testing)
└── Dockerfile  docker-compose.yml  tsconfig.json  package.json
```

### Adding a feature

The rule that makes this safe: **a feature touches one folder.**

- A new route goes in `controllers/`, registered from `app.ts`.
- New work goes in `services/`. If a service needs a third concern, that is a
  new file, not a bigger one.
- Domain logic goes in `features/agent/`.
- New chat behaviour is a new stage in `services/chat/` plus one entry in its
  `index.ts`. The order of a turn is declared in exactly one place.

`app.ts` and `server.ts` are the two files to read first, and neither contains
feature code. If a change needs either of them, that is a signal the feature is
being wired somewhere it should not be.

### The chat pipeline

`/api/chat` is a sequence of seven stages in `services/chat/`:

```
identify -> authorise -> startSession -> stageUploads
         -> buildContext -> callModel -> decideAndStore
```

A stage takes a context, mutates what it knows, and returns either `null` to
carry on or a result to answer the user with. A non-null result ends the turn.

That replaced one 526-line handler with nine hidden exit points, in which every
stage sat in the same scope as every other one.

## Testing

Every suite runs against a scratch data directory with no database, no AI
provider key and no webhook, so none can touch production or spend tokens.

| Suite | Guards against |
|-------|----------------|
| `smoke-regress.cjs` | routes disappearing during a refactor; a health check that reports green over a dead database; a catalog returning an error object with a 200 |
| `durability-regress.cjs` | history or the greeting flag being lost across a restart; duplicated messages from a racing write |
| `modal-regress.cjs` | the three ticket forms, catalog-backed dropdowns, and the payload sent to n8n |
| `widget-regress.cjs` | the widget's rendering and its contract with the server |
| `commands-regress.cjs` | slash commands, AI retry classification, greetings |
| `identity-*.cjs` | role resolution and token signing |

## Attachment Storage

Chat conversations live in the `ami_data` volume and need nothing from you.
Ticket attachments are different: MIS stores every attachment as a row in
`scrf_attachment` whose `file_directory` is a **relative** path under the legacy
app's `file_master/` folder, and requesters download them from there.

Observed layout, from 8040 of 8091 existing rows:

```
file_master/my_system_request/<SCRF control number>/<original filename>   System Request
file_master/support_files/<AIPS control number>/<original filename>       Tech Support
```

Because `file_directory` is relative, PHP resolves it against the web app's own
working directory — so `file_master/` is a folder inside the MIS web root.
Whether that folder is local disk or a NAS mount is what you must confirm on the
MIS server:

```bash
cd <webroot>                  # the directory holding scrf.form.php
findmnt -T file_master        # nfs4/cifs => NAS; ext4/xfs => local disk
df -hT file_master
readlink -f file_master       # resolves it if it is a symlink
```

### Why the chatbot cannot write there directly

The legacy order is: mint the control number → create the folder → move the file.
Here **n8n mints the control number** and returns it later, so at upload time the
final folder is not yet knowable. The app therefore stages each file and n8n moves
it:

```
1. POST /api/ticket  ──▶  file writes to   $ATTACHMENTS_DIR/_incoming/<key>/<original name>
2. n8n mints control number  (e.g. AIP26100030)
3. n8n moves it to         $ATTACHMENTS_DIR/my_system_request/<control>/<name>     (system_request)
                          $ATTACHMENTS_DIR/support_files/<control>/<name>          (tech_support)
4. n8n inserts scrf_attachment(file_directory = 'file_master/<...>/<name>')
```

Steps 2-4 happen in n8n. Both steps sit under the same root, so the move is an
atomic rename rather than a copy.

### Mounting it on the Ubuntu host

Out of the box `ATTACHMENTS_DIR` is unset and resolves to `/app/data/attachments`,
which is already on the `ami_data` volume. Attachments therefore **persist and
work with no extra setup** — they just are not yet on the NAS.

For production, set it to the directory that **is** `file_master`, and mount it at
the **same absolute path** in both the chatbot and the n8n container — the app
sends absolute `staged_path` values that n8n reads unchanged.

Mount the NAS on the host first; Docker does not manage host mounts:

```bash
sudo apt install -y nfs-common
# /etc/fstab  — use 'hard' rather than 'soft': soft can corrupt on network blips
192.1.5.20:/volume1/file_master /mnt/nas/file_master nfs4 rw,hard,_netdev,vers=4.1 0 0
sudo mount /mnt/nas/file_master
```

Then in `docker-compose.yml` for the chatbot (both lines are already there,
commented):

```yaml
      - ATTACHMENTS_DIR=/app/attachments
      volumes:
        - /mnt/nas/file_master:/app/attachments
```

and give n8n the identical mount and path:

```yaml
      - /mnt/nas/file_master:/app/attachments
```

**The container runs as uid 1001** (`ami`, see `Dockerfile`). NAS shares commonly
`root_squash` and are owned by another uid, so this is the step that actually
breaks. Verify before trusting the deployment:

```bash
docker exec ami-helpdesk-chatbot touch /app/attachments/.probe && \
  docker exec ami-helpdesk-chatbot rm /app/attachments/.probe && echo OK
```

If that fails, map uid 1001 on the NAS side or fix the share's permissions. Do
not fall back to `user: "0:0"` unless you have no other option.

### Behaviour when the share is missing

The staging root is checked for writability at startup. If it is absent or
read-only the server logs one `attachment_staging_unavailable` warning and **still
boots** — chat, triage and ticket creation without files all keep working. Only
attachment uploads fail, with a message saying the share is not mounted. A NAS
outage should not take the chatbot down.

### Attachments per ticket type

| Ticket type | Attachments |
|-------------|-------------|
| System Request | Yes |
| Tech Support | Yes |
| IT Asset | **No** — the legacy form has no file input and MIS has no folder convention for one, so the picker is hidden and the server rejects them |

Filenames keep their original form (`Security Report 29-Jun-2026.docx`), because
requesters see these names in the MIS job list. `#` becomes `-`, matching
`scrf.form.php`. The old chat intake hashed filenames into uuids, which was
useless to anyone opening the file.

## Deployment Notes

1. **Database**: PostgreSQL 16+ (or JSON fallback if `DATABASE_URL` unset)
2. **Reverse Proxy**: Terminate TLS at proxy, forward HTTP to container port 3000
3. **Volumes**: `ami_data` (conversations/uploads), `ami_pgdata` (PostgreSQL)
4. **Attachment storage**: `ATTACHMENTS_DIR` must point at the NAS-backed `file_master`, mounted at the same path in the chatbot and n8n — see [Attachment Storage](#attachment-storage)
5. **Health Checks**: `/api/health` returns `200` only when storage can actually serve requests, and `503` with the missing tables named when it cannot. A monitoring system watching this should alert on `503`; it will not go green through a database outage.
6. **Scaling**: Stateless chatbot - can run multiple replicas behind load balancer
7. **MIS Integration**: Requires MIS database access for catalogs and user directory

### n8n workflow — import before first ticket

The flow is not deployed from this repository; it is imported into your own n8n.

1. In n8n: **Workflows → Import from File**
2. Import `Ami Helpdesk - Ticket Creator (fixed).json`
3. Re-select the MySQL credentials on every `MySQL` node (they do not travel
   with an export)
4. Re-select the Gmail account on **Send a message**
5. Activate the workflow

Import the **fixed** file, not the original. The original has six defects that
corrupt tickets rather than failing loudly; they are listed in
[docs/FLOW_DATA.md](docs/FLOW_DATA.md#the-six-fixes-in-the-corrected-workflow).
The two that matter most:

- A multi-system ticket shifts every MIS column to its right, leaving the
  requester name, employee number and e-mail **empty**.
- The no-attachment branch has no connection, so the run simply stops and the
  chatbot reports *"n8n accepted the request but returned no control number"*.

To confirm it is working, submit one ticket per type and check that
`MIS_JOB_LIST` shows the requester, a control number, and the right category.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "No AI provider configured" | Set `GEMINI_API_KEY` in `.env` |
| "Database unavailable" | Check `DATABASE_URL` or ensure Postgres is healthy |
| "No identity" | Widget must send `login_user` from MIS PHP session |
| "Not admin" | Add user to `ADMIN_USERS` or promote in MIS |
| Files not uploading | Check `MAX_FILE_SIZE` and disk space |

## License

Internal use only - Amertron Corporation MIS Department
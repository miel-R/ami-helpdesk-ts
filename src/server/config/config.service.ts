// Server Configuration
import 'dotenv/config';
import path from 'path';

/**
 * Project root - the single source of truth for every path this app resolves.
 *
 * THREE levels up, not two. This file lives in src/server/config/, so __dirname
 * is .../server/config and the app root is three segments above it:
 *
 *     src/server/config/config.service.ts  ->  src        ->  project root
 *
 * It said `..`, `..` while the file sat directly in src/server/, which was
 * correct then and wrong the moment it moved into its own folder. That silently
 * pointed publicDir, uploadsDir and conversationsDir at `dist/` instead of the
 * app root, and every static asset 404'd: /widget.js, the admin page, the
 * stylesheet. Nothing failed to start, and the health check stayed green, because
 * storage lives in a volume and does not depend on any of these paths.
 *
 * The climb is asserted in the regression suite so a future move cannot repeat it.
 */
const ROOT = path.join(__dirname, '..', '..', '..');

export interface MisDbConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '', 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'production',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  /**
   * Timezone used for the timestamps written onto tickets.
   *
   * Not cosmetic. The container runs UTC while MIS is in the Philippines, so
   * stamping a ticket with the container's own clock files every ticket eight
   * hours behind the real time, and nothing else notices. The stamp is
   * converted into this zone explicitly instead, and defaults to Manila so it is
   * right without configuration.
   */
  timezone: process.env.TIMEZONE || 'Asia/Manila',

  // AI Providers
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite'
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },

  // Webhooks
  n8n: {
    webhookUrl: process.env.N8N_WEBHOOK_URL || '',
    testWebhookUrl: process.env.N8N_TEST_WEBHOOK_URL || ''
  },

  // Authorization
  //
  // The MIS helpdesk (PHP) is the identity provider. It cannot be trusted from
  // the request body, because the widget is client-side and anyone can post
  // `user_role=admin`, so the role is either SIGNED by MIS or read from MIS's
  // own database server-to-server (see misDirectory). Only if neither is
  // available does it fall back to users.role plus ADMIN_USERS.
  adminUsers: process.env.ADMIN_USERS || '',

  /** Shared secret for signed identity assertions. Never sent to the browser. */
  identitySecret: process.env.IDENTITY_SECRET || '',

  /** Read-only MIS user directory. Blank host disables it. */
  misDb: {
    host: process.env.MIS_DB_HOST || '',
    port: parseInt(process.env.MIS_DB_PORT || '', 10) || 3306,
    user: process.env.MIS_DB_USER || '',
    password: process.env.MIS_DB_PASSWORD || '',
    database: process.env.MIS_DB_NAME || ''
  } as MisDbConfig,

  // Storage
  storage: {
    conversationsDir: process.env.CONVERSATIONS_DIR || './data/conversations/',
    attachmentsDir: process.env.ATTACHMENTS_DIR || './data/attachments/',
    uploadsDir: process.env.UPLOADS_DIR || './data/uploads/',
    flowsDir: process.env.FLOWS_DIR || './flows/',
    ragDir: process.env.RAG_DIR || './data/rag/'
  },

  // Rate Limiting
  rateLimit: {
    /** Tickets a user may open per day. */
    perDay: parseInt(process.env.RATE_LIMIT_PER_DAY || '', 10) || 10,
    /** Chat requests per day. Deliberately generous; admins can lower per person. */
    requestsPerDay: parseInt(process.env.REQUESTS_PER_DAY || '', 10) || 100,
    perMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '', 10) || 30,
    windowMs: 60 * 1000
  },

  // Conversation
  conversation: {
    maxHistory: parseInt(process.env.MAX_HISTORY || '', 10) || 20,
    /**
   * Idle threshold in ms, sent to the widget so it can retire stale markers.
   *
   * 10 minutes. Long enough that someone pausing mid-ticket to read something is
   * not cut off, short enough that a walk-away is treated as a finished
   * conversation rather than something to resume hours later. Override with
   * SESSION_TIMEOUT in ms, or SESSION_TIMEOUT_MINUTES for a friendlier unit.
   */
  sessionTimeout: (() => {
    const mins = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '', 10);
    if (Number.isFinite(mins) && mins > 0) return mins * 60 * 1000;
    const ms = parseInt(process.env.SESSION_TIMEOUT || '', 10);
    return Number.isFinite(ms) && ms > 0 ? ms : 5 * 60 * 1000;
  })(),
  /**
   * When to nudge the user before session end, in ms.
   *
   * Default 4 minutes. Must be less than sessionTimeout. Override with
   * SESSION_NUDGE_MINUTES.
   */
  nudgeAfter: (() => {
    const mins = parseInt(process.env.SESSION_NUDGE_MINUTES || '', 10);
    if (Number.isFinite(mins) && mins > 0) return mins * 60 * 1000;
    return 4 * 60 * 1000;
  })(),
    cleanupInterval: 30000
  },

  // Pricing, for usage reporting (per 1K tokens).
  pricing: {
    gemini: { input: 0.0001, output: 0.0003 },
    openai: { input: 0.00015, output: 0.0006 }
  },

  // Feature flags
  features: {
    chatbotEnabled: true,
    ragEnabled: true,
    fileUploads: true,
    multiFile: true,
    webhook: true
  },

  // Security
  security: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '', 10) || 10 * 1024 * 1024,
    allowedImageTypes: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'],
    allowedDocTypes: ['csv', 'txt', 'xlsx'],
    helmet: true,
    corsOrigin: process.env.CORS_ORIGIN || '*',

    /**
     * How many reverse proxies sit in front of this process.
     *
     * Express derives `req.ip` from the socket, which behind a proxy is the
     * PROXY's address, so every request looked like it came from one host.
     * Rate limiting keys on `req.ip` by default, which meant the entire company
     * shared a single bucket: 30 messages a minute between everyone, and
     * `Too many requests` for people who had sent nothing. Nothing here would
     * have shown up in a single-user test.
     *
     * Apache is expected in front of this in production, hence the default of 1.
     * The count is what matters: `true` trusts every hop and lets a client
     * spoof `X-Forwarded-For` outright, which would defeat the limiter entirely,
     * so it is deliberately not offered. Set to 0 if the process is reached
     * directly.
     */
    trustProxyHops: (() => {
      const raw = String(process.env.TRUST_PROXY_HOPS ?? '1').trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 1;
    })()
  },

  // Paths, resolved from the project root rather than process.cwd() so the server
  // behaves the same however it was launched.
  //
  // The *_DIR overrides are what let the regression suites run against a scratch
  // directory. They used to be read only by `storage` above, which nothing
  // consumed, so every "isolated" suite was in fact writing into the real data/
  // directory and into whatever conversation file it happened to share. Anything
  // that writes state must read these, not a hardcoded path.
  paths: {
    root: ROOT,
    // DATA_DIR relocates users.json / usage.json / the disable flag, which are
    // otherwise pinned to the real data/ directory even when every other path is
    // redirected. Without it a run with DATABASE_URL unset writes into the
    // developer's actual data.
    dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
    conversationsDir: process.env.CONVERSATIONS_DIR || path.join(ROOT, 'data', 'conversations'),
    attachmentsDir: process.env.ATTACHMENTS_DIR || path.join(ROOT, 'data', 'attachments'),
    uploadsDir: process.env.UPLOADS_DIR || path.join(ROOT, 'data', 'uploads'),
    ragDir: process.env.RAG_DIR || path.join(ROOT, 'rag'),
    publicDir: path.join(ROOT, 'public')
  }
};

export type Config = typeof config;
export default config;
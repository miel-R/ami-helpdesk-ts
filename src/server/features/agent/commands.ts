// Chat commands ($help, $reset, $status, ...).
//
// Ported from the legacy PHP build (HELPDESK/ami-helpdesk/ami.php). Commands are
// answered here and never reach the AI, which keeps them instant and free and
// guarantees they work even when no provider key is configured.
//
// Every command records both the user's message and the reply in the session, so
// the transcript stays truthful about what actually happened.

import fs from 'fs';
import path from 'path';
import os from 'os';

import { config } from '../../config/config.service';
import conversationManager from '../../services/session.service';
import { db, kind as dbKind } from '../../db/storage.service';
import { callAI } from '../../ai';
import { triggerWebhook, buildResolvedPayload, sampleTicketFields } from '../../services/ticket/webhook.service';
import { isWebhookDebug, setWebhookDebug, webhookDebugSince } from '../../core/flags';
import * as catalog from '../../services/catalog';
import { serverStartedAt } from '../../core/logger';
import type { StoredConversationRow } from '../../db/storage.service';
import type { Conversation, SessionUser } from '../../models/types.model';

// A file flag rather than a config value, so $disable survives a restart and
// applies to every user rather than only the one who typed it.
const DISABLED_FLAG = path.join(config.paths.dataDir, 'chatbot_disabled');

export function isDisabled(): boolean {
  try { return fs.existsSync(DISABLED_FLAG); } catch { return false; }
}

export function setDisabled(on: boolean): boolean {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(DISABLED_FLAG), { recursive: true });
      fs.writeFileSync(DISABLED_FLAG, new Date().toISOString(), 'utf8');
    } else if (fs.existsSync(DISABLED_FLAG)) {
      fs.unlinkSync(DISABLED_FLAG);
    }
    return true;
  } catch {
    return false;
  }
}

const ADMIN_COMMANDS = [
  '$disable', '$enable', '$list', '$test-webhook', '$diagnose',
  '$export-consumption', '$webhook-debug'
];
const ALL_COMMANDS = ['$help', '$whoami', '$status', '$reset', '$end', ...ADMIN_COMMANDS];

/**
 * The facts behind the current role decision.
 *
 * Only non-secret facts live here: never the token, never the secret.
 */
export interface IdentityStatus {
  secretConfigured: boolean;
  directoryConfigured: boolean;
  tokenReceived: boolean;
  tokenValid: boolean;
  loginMatched: boolean;
  misRole: string | null;
  roleSource: string;
}

// Latest identity resolution, set by the chat route on every request so
// $diagnose can explain a role decision instead of leaving the user to guess.
const identityStatus: IdentityStatus = {
  secretConfigured: !!config.identitySecret,
  directoryConfigured: !!config.misDb && !!config.misDb.host,
  tokenReceived: false,
  tokenValid: false,
  loginMatched: false,
  misRole: null,
  roleSource: 'database'
};

export function setIdentityStatus(patch: Partial<IdentityStatus>): IdentityStatus {
  Object.assign(identityStatus, patch);
  return identityStatus;
}

// Describe the configured webhook so error messages stay accurate when the
// workflow ID changes. This used to be a hardcoded UUID in the message, which
// went stale the moment N8N_WEBHOOK_URL was updated.
function describeWebhookPath(urlOverride?: string): string {
  const url = urlOverride || config.n8n.webhookUrl;
  if (!url) return '(not set)';
  const m = String(url).match(/\/webhook(-test)?\/([^/?#]+)/i);
  if (!m) return url;
  return `${m[1] === '-test' ? '/webhook-test/' : '/webhook/'}${m[2]}`;
}

// Explain the role decision in plain words. The common failure is a MIS page that
// sends no token at all, or one signed with a different secret, and both look
// identical from the outside: the person is simply "user". Naming the failing
// step saves a lot of guesswork.
function identityDiagnostics(): string[] {
  const s = identityStatus;
  const lines = ['- IDENTITY_SECRET: ' + (s.secretConfigured ? 'configured' : 'NOT SET (IDENTITY_SECRET)')];
  lines.push('- MIS directory: ' + (s.directoryConfigured ? 'configured (roles read live from MIS)' : 'NOT SET (MIS_DB_HOST)'));

  if (s.roleSource === 'mis-directory') {
    lines.push('- Role source: **MIS user directory**');
  } else if (s.roleSource === 'allowlist') {
    lines.push('- Role source: ADMIN_USERS allowlist');
  }

  if (!s.secretConfigured && !s.directoryConfigured) {
    lines.push('  Role comes from the database / ADMIN_USERS instead.');
    return lines;
  }
  if (!s.tokenReceived && !s.directoryConfigured) {
    lines.push('- Signed role: **no token received** - AmiChatConfig.identityToken is missing or empty on the MIS page');
    return lines;
  }
  if (!s.tokenValid) {
    lines.push('- Signed role: token **rejected** - bad signature or expired');
    lines.push('  The MIS page and this server must share the exact same IDENTITY_SECRET.');
    return lines;
  }
  if (!s.loginMatched) {
    lines.push('- Signed role: valid, but for a **different login** than this request');
    return lines;
  }
  lines.push(`- Signed role: accepted from MIS as **${s.misRole}**`);
  lines.push(`- Role source: ${s.roleSource}`);
  return lines;
}

// One-line version for $whoami, which every user can run. $diagnose cannot be
// used for this: it is admin-only, so someone whose role is not resolving
// correctly is exactly the person who cannot open it.
function identityHint(): string {
  const s = identityStatus;
  if (s.roleSource === 'mis-directory') {
    return '\n\n_Role from: the MIS user directory (read live from MIS)._';
  }
  if (s.roleSource === 'allowlist') {
    return '\n\n_Role from: the ADMIN_USERS allowlist._';
  }
  if (!s.secretConfigured && !s.directoryConfigured) return '\n\n_Role from: the server database._';
  if (!s.tokenReceived && !s.directoryConfigured) {
    return '\n\n_Role from: the server database - the MIS page sent no signed role, and the MIS directory is not configured._';
  }
  if (s.directoryConfigured) return '\n\n_Role from: the server database - MIS has no record of this login._';
  if (!s.tokenReceived) {
    return '\n\n_Role from: the server database - the MIS page sent no signed role._';
  }
  if (!s.tokenValid) {
    return '\n\n_Role from: the server database - the signed role was **rejected**. Check that the MIS page and the server use the same `IDENTITY_SECRET`._';
  }
  if (!s.loginMatched) {
    return '\n\n_Role from: the server database - the signed role was for a different login._';
  }
  return `\n\n_Role from: MIS, signed as **${s.misRole}**._`;
}

export function helpText(isAdmin: boolean): string {
  let help = "Hi! I'm Ami, your helpdesk assistant.\n\n"
    + '**What you can do**\n'
    + '- Ask me anything about IT, HR, Finance, Engineering, or Manufacturing\n'
    + "- Describe a problem and I'll walk you through troubleshooting\n"
    + '- Say "create a ticket" if you need MIS to take over\n\n'
    + '**Commands**\n'
    + '- `$help` this message\n'
    + '- `$status` current conversation state\n'
    + '- `$whoami` the account I recognise you as\n'
    + '- `$reset` clear this conversation\n'
    + '- `$end` end the conversation';

  if (isAdmin) {
    help += '\n\n**Admin commands**\n'
      + '- `$list` list stored conversations\n'
      + '- `$export-consumption` where to review token usage\n'
      + '- `$diagnose` check the AI provider connection\n'
      + '- `$test-webhook system|tech|asset` send a sample payload to n8n\n'
      + '- `$webhook-debug on|off` send ALL tickets to the test webhook while debugging\n'
      + '- `$disable` / `$enable` turn the chatbot on or off';
  }
  return help;
}

/**
 * Record the command and its reply so history stays accurate.
 *
 * Awaited by its callers so a slash command cannot vanish from the transcript
 * across a restart, and so the queue keeps the two messages in order.
 */
async function record(
  sessionId: string,
  session: Conversation,
  userMessage: string,
  reply: string
): Promise<void> {
  const now = new Date().toISOString();
  session.messages.push({ role: 'user', content: userMessage, timestamp: now });
  session.messages.push({ role: 'assistant', content: reply, timestamp: now });
  await conversationManager.saveConversation(sessionId);
}

function statusText(session: Conversation): string {
  const mode = session.mode || 'chat';
  const modeLabel = mode === 'escalated' ? 'ticket created' : 'just chatting';

  const usage = (session.usage ?? {}) as { total_tokens?: number };
  let out = '**Status**\n'
    + `- Mode: ${modeLabel}\n`
    + `- Messages: ${(session.messages || []).length}\n`;

  if (session.last_control_number) out += `\n- Control number: ${session.last_control_number}`;
  if ((session.attachments || []).length) out += `\n- Attachments: ${(session.attachments || []).length}`;
  if (usage.total_tokens) out += `\n- Tokens used: ${Number(usage.total_tokens).toLocaleString('en-US')}`;
  if (isWebhookDebug()) {
    out += '\n- **Webhook debug mode is ON - tickets are going to the test endpoint, not to MIS.**';
  }
  return out;
}

async function listText(): Promise<string> {
  let rows: StoredConversationRow[] = [];
  try { rows = await db().listConversations({ limit: 25 }); } catch { /* fall through */ }
  if (!rows || !rows.length) return 'No conversations stored yet.';

  const lines = rows.slice(0, 25).map(r => {
    const state = (r.state ?? {}) as { usage?: { total_tokens?: number } };
    const u = state.usage || {};
    const tokens = Number(u.total_tokens || 0).toLocaleString('en-US');
    return `- ${r.username || r.session_id} | ${r.status || 'active'} | ${r.message_count ?? 0} msgs | ${tokens} tokens | ${r.updated_at || ''}`;
  });
  return `**Conversations (${rows.length})**\n${lines.join('\n')}`;
}

async function diagnoseText(): Promise<string> {
  const lines = [
    '**Ami diagnostics**',
    `- Node: ${process.version}`,
    `- Platform: ${os.platform()} ${os.arch()}`,
    `- Uptime: ${Math.floor((Date.now() - serverStartedAt) / 1000)}s`,
    `- Gemini key: ${config.gemini.apiKey ? 'set' : 'NOT SET (GEMINI_API_KEY)'}`,
    `- OpenAI key: ${config.openai.apiKey ? 'set' : 'NOT SET (OPENAI_API_KEY)'}`,
    `- Storage: ${dbKind()}`,
    `- Webhook: ${config.n8n.webhookUrl ? 'configured' : 'NOT SET (N8N_WEBHOOK_URL)'}`,
    `- Chatbot: ${isDisabled() ? 'DISABLED' : 'enabled'}`,
    ...identityDiagnostics()
  ];

  let probe = 'skipped (no provider key)';
  if (config.gemini.apiKey || config.openai.apiKey) {
    try {
      const res = await callAI([{ role: 'user', content: 'Reply with the single word: pong' }], '');
      probe = String(res.text || '').trim().slice(0, 120) || '(empty reply)';
    } catch (e) {
      probe = `FAILED: ${(e as Error).message}`;
    }
  }
  lines.push(`- Probe result: ${probe}`);
  return lines.join('\n');
}

async function testWebhookText(argument?: string): Promise<string> {
  const type = String(argument || '').trim().toLowerCase() || 'system';
  const allowed: Record<string, string> = { system: 'system_request', tech: 'tech_support', asset: 'it_asset' };
  const ticketType = allowed[type];
  if (!ticketType) return `Unknown ticket type "${type}". Use one of: system, tech, asset.`;

  // Prefer the TEST endpoint so probing never writes into the live ticket
  // tables. N8N_TEST_WEBHOOK_URL was defined in config.ts and then referenced
  // nowhere, so $test-webhook silently hit production.
  const testUrl = config.n8n.testWebhookUrl;
  const usingTest = !!testUrl;
  const target = usingTest ? testUrl : config.n8n.webhookUrl;
  if (!target) {
    return 'Neither `N8N_WEBHOOK_URL` nor `N8N_TEST_WEBHOOK_URL` is set in .env, so there is nowhere to send this.';
  }

  // Built by the SAME function a real submission uses, so an n8n insert that works
  // against this probe works against a genuine ticket. Only `_test: true` and the
  // sample values differ.
  // Resolved from MIS so the probe carries a real employee number when one exists.
  // 'test.user' is not a real MIS account, so a deliberately impossible
  // sentinel is used instead - obvious if it ever lands in a table, while still
  // letting an insert that requires a requester id be validated end to end
  // rather than failing only on the first genuine ticket.
  const probeMis = await catalog.misUser('test.user');
  const probeUserId = probeMis?.userId || '999999999';

  const result = await triggerWebhook(
    await buildResolvedPayload({
      ticketType,
      department: 'mis',
      userName: 'Test User',
      user: {
        user_name: 'Test User',
        first_name: 'Test',
        last_name: 'User',
        email: 'test@example.com',
        department: 'MIS',
        role: 'user',
        login: 'test.user',
        mis_user_id: probeUserId
      },
      collectedFields: sampleTicketFields(ticketType),
      test: true
    }),
    target
  );

  if (!result.ok) {
    // A 404 from n8n has one overwhelmingly common cause, and n8n says so in
    // the body. Say it plainly rather than passing an HTTP status back as if
    // the endpoint were simply unreachable.
    if (result.status === 404) {
      const where = usingTest
        ? 'the **test** endpoint (`N8N_TEST_WEBHOOK_URL`)'
        : 'the **production** endpoint (`N8N_WEBHOOK_URL`)';
      const why = usingTest
        ? 'A test URL only answers while the workflow editor is open AND you have clicked\n"Execute workflow".'
        : 'A production URL only answers while the workflow is **active** (toggle, top-right).';
      return `Webhook **not found (HTTP 404)**. I sent this to ${where}.

${why}

n8n said: ${result.error}

Configured path: \`${describeWebhookPath(target)}\``;
    }
    // n8n also rejects the workflow itself, before any ticket work happens, when
    // the workflow contains a "Respond to Webhook" node that the incoming
    // request's execution path never reaches. n8n raises this as a 500 with the
    // reason only in the message, which reads like a server fault when it is
    // really a workflow-authoring problem on the n8n side. Name it and say where
    // the fix belongs, because no amount of retrying from here will help.
    if (/unused respond to webhook/i.test(result.error ?? '')) {
      return `Webhook **rejected by n8n (HTTP ${result.status ?? 500})**: the workflow is not runnable as it stands.

This is a problem inside the n8n workflow, not with the ticket or with me:
the workflow contains a **Respond to Webhook** node that this request's path
never reaches, so n8n refuses to execute.

To fix it, open the workflow in n8n and either:
- connect the **Respond to Webhook** node into the path that runs after the
  Webhook trigger, or
- delete it if the workflow does not need to send a response body.

Then run **$test-webhook** again.

n8n said: ${result.error}`;
    }
    return `Webhook **failed**: ${result.error}\n\n(Sent to ${usingTest ? 'the test endpoint' : 'the production endpoint'}.)`;
  }
  // A 200 only proves n8n accepted the payload. `success` is what n8n says about
  // its OWN insert, and it answers 200 even when that insert failed - so an
  // explicit success:false is reported as a failure, not shrugged off.
  const body = (result.body ?? {}) as {
    control_number?: unknown;
    success?: unknown;
    error?: unknown;
  };
  const cn = body.control_number ? String(body.control_number).trim() : '';
  const reportedFailure = body.success === false || body.success === 0 || body.success === 'false';
  const workflowError = body.error ? String(body.error) : '';

  if (reportedFailure) {
    return `Webhook **FAILED** (HTTP ${result.status}) - n8n accepted the request but its own insert did not succeed.

Nothing was created${workflowError ? `: ${workflowError}` : ''}. The workflow ran, so the problem is on the n8n side - check the node that writes to your database and look at the execution log for the error.

n8n response: \`${JSON.stringify(body)}\``;
  }

  if (cn) {
    return `Webhook **OK** (HTTP ${result.status}) - n8n generated a ticket number.

**Control number: ${cn}**

Note: this created a real test ticket in n8n. It is NOT written to this
server's conversation database, because $test-webhook posts a sample payload
straight to n8n and never goes through ticket intake.

n8n response: \`${JSON.stringify(body)}\``;
  }

  return `Webhook **OK** (HTTP ${result.status}), but n8n returned **no control number**.

That means the workflow ran and answered, but the \`control_number\` field was
missing from its response - check that the Respond to Webhook node sits AFTER
the node that builds it (\`Build Control\`), and that \`$('Build Control').item.json\`
is resolving rather than returning null.

n8n response: \`${JSON.stringify(body)}\``;
}

/**
 * Show or change webhook debug mode.
 *
 * While on, every ticket Ami creates is posted to the n8n TEST endpoint so the
 * workflow can be iterated on without writing real tickets. While off, tickets go
 * to production as normal.
 *
 * $webhook-debug on | off | status
 *   no argument  -> reports the current state and changes nothing
 *
 * Requires no restart either way, and the state survives one.
 */
function webhookDebugText(argument?: string): string {
  const arg = String(argument || '').trim().toLowerCase();
  const on = isWebhookDebug();
  const since = webhookDebugSince();

  const current = (): string =>
    `Webhook debug mode is **${on ? 'ON' : 'OFF'}** - tickets are going to the `
    + `**${on ? 'TEST' : 'PRODUCTION'}** webhook`
    + (on && since ? ` (since ${since})` : '')
    + `.\n\nUse \`$webhook-debug on\` or \`$webhook-debug off\`.`;

  if (arg === 'on' || arg === 'true' || arg === '1') {
    if (on) return current();
    if (!config.n8n.testWebhookUrl) {
      return 'Cannot turn webhook debug mode on: `N8N_TEST_WEBHOOK_URL` is not set '
        + 'in .env, so there is no test endpoint to send to. Tickets would otherwise '
        + 'keep going to production and you would think they were being tested.';
    }
    if (!setWebhookDebug(true)) {
      return "Sorry, I couldn't write the webhook debug flag.";
    }
    return `**Webhook debug mode is ON.**\n\n`
      + `Every ticket Ami creates from now on is posted to the **test** webhook `
      + `(\`${config.n8n.testWebhookUrl}\`), not production.\n\n`
      + `**Real tickets will NOT be created** while this is on - n8n will still run `
      + `and hand back a control number, but nothing is filed in the live MIS tables.\n\n`
      + `Because of that, **only admins can raise tickets** while this is on. Everyone `
      + `else is told MIS is in debug mode rather than having their ticket silently `
      + `discarded. Your own tickets still go through to the test webhook and still `
      + `come back with a control number.\n\n`
      + `Remember to run \`$webhook-debug off\` when you are done. This survives a `
      + `restart, so it will stay on until you turn it off.`;
  }

  if (arg === 'off' || arg === 'false' || arg === '0') {
    if (!on) return current();
    if (!setWebhookDebug(false)) {
      return "Sorry, I couldn't remove the webhook debug flag.";
    }
    return `**Webhook debug mode is OFF.**\n\n`
      + `Tickets are going to the **production** webhook again `
      + `(\`${config.n8n.webhookUrl || 'not set'}\`).`;
  }

  if (arg && arg !== 'status' && arg !== 'state') {
    return `I don't understand "${argument}". Use \`$webhook-debug on\`, `
      + `\`$webhook-debug off\`, or just \`$webhook-debug\` to see where tickets are going.`;
  }

  return current();
}

/** What handleCommand() needs to answer a command. */
export interface CommandContext {
  sessionId: string;
  session: Conversation;
  user: SessionUser;
  userName: string;
}

/** The payload a command returns, or null when the text is not a command. */
export interface CommandResult {
  reply: string;
  provider: string;
  mode: Conversation['mode'];
  ticket_created: boolean;
}

/**
 * Handle a chat command.
 *
 * Returns null if the message is not a command, so the caller can fall through
 * to the AI.
 */
export async function handleCommand(
  message: string,
  ctx: CommandContext
): Promise<CommandResult | null> {
  const text = String(message || '').trim();
  if (!text.startsWith('$')) return null;

  const { sessionId, session, user, userName } = ctx;
  const isAdmin = !!user && user.role === 'admin';
  const command = text.split(/\s+/)[0].toLowerCase();
  const argument = text.slice(command.length).trim();

  let reply: string | null = null;

  if (command === '$help') {
    reply = helpText(isAdmin);
  } else if (command === '$whoami') {
    // Show the ROLE, not the department: it is the fact that matters for what
    // the user may do here, and main.ts always resolves it to 'admin' or 'user'
    // from the users row / ADMIN_USERS rather than trusting the request body.
    const role = (user && user.role) || '';
    reply = `You're chatting as **${userName}**${role ? ` (${role})` : ''}.${identityHint()}`;
  } else if (command === '$status') {
    reply = statusText(session);
  } else if (command === '$reset') {
    // Delete storage, then start a genuinely clean session. restored=true stops
    // the deferred storage read from resurrecting what we just deleted.
    conversationManager.deleteConversation(sessionId);
    const fresh = conversationManager.getConversation(sessionId);
    fresh.restored = true;
    fresh.user = { ...fresh.user, ...user };
    Object.assign(session, fresh);
    reply = `All cleared! What can I help you with, ${userName}?`;
  } else if (command === '$end') {
    session.mode = 'chat';
    session.pending_question = null;
    session.intake_stage = null;
    reply = `Thanks for chatting, ${userName}! I'm here whenever you need me.`;
  } else if (ADMIN_COMMANDS.includes(command)) {
    if (!isAdmin) {
      reply = 'Sorry, that command is for administrators only.';
    } else if (command === '$diagnose') {
      reply = await diagnoseText();
    } else if (command === '$list') {
      reply = await listText();
    } else if (command === '$test-webhook') {
      reply = await testWebhookText(argument);
    } else if (command === '$webhook-debug') {
      reply = webhookDebugText(argument);
    } else if (command === '$export-consumption') {
      reply = 'Token and cost usage lives on the admin dashboard (**Cost & Tokens** tab), where you can filter by user and review the per-message ledger.';
    } else if (command === '$disable') {
      reply = setDisabled(true) ? 'Chatbot disabled for all users.' : "Sorry, I couldn't write the disable flag.";
    } else if (command === '$enable') {
      reply = setDisabled(false) ? 'Chatbot enabled for all users.' : "Sorry, I couldn't remove the disable flag.";
    }
  }

  if (reply === null) {
    reply = `I don't know the command \`${command}\`.`
      + (ALL_COMMANDS.includes(command) ? '' : ' Try `$help` to see what I support.');
  }

  // Awaited: the caller answers with this reply, so it must be stored first.
  await record(sessionId, session, text, reply);
  return { reply, provider: 'system', mode: session.mode, ticket_created: false };
}

export function isCommand(m: unknown): boolean {
  return String(m ?? '').trim().startsWith('$');
}

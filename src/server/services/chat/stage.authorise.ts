// Stage 2 - may they, and are they talking to Ami or to the command parser.
//
// Three things happen here and they are deliberately in this order:
//
//   1. quota, so a blocked user is turned away before any work is done;
//   2. the role, resolved from the token and the MIS directory rather than from
//      anything the request asserted;
//   3. slash commands, which are answered locally and never reach the model.
//
// Commands have to come before the model is billed, and the role has to come
// before either, because `$enable` is only honoured for an admin.

import { logEvent } from '../../core/logger';
import { config } from '../../config/config.service';
import * as limits from '../quota.service';
import * as commands from '../../features/agent/commands';
import * as misDirectory from '../mis-directory.service';
import { resolveRole } from '../identity.service';
import conversationManager from '../session.service';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';

export const authorise: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const { body, message } = ctx;
  const quotaUser = ctx.quotaUser as string;
  const sessionId = ctx.sessionId as string;
  const user = ctx.user!;

  const access = await limits.checkAccess(quotaUser);
  if (!access.allowed) {
    logEvent('warn', 'access_denied', { user: quotaUser, code: access.code });
    return {
      status: 403,
      body: {
        error: access.reason,
        code: access.code,
        limit: Number.isFinite(access.limit) ? access.limit : null,
        used: access.used,
        remaining: access.remaining
      }
    };
  }

  const storedUser = ctx.storedUser as { role?: string } | null;
  const storedRole = (access.user && access.user.role) || (storedUser && storedUser.role) || 'user';
  const directory = await misDirectory.lookupRole(quotaUser);
  const resolved = resolveRole({
    loginId: quotaUser,
    dbRole: storedRole,
    identityToken: body.identity_token,
    secret: config.identitySecret,
    allowlist: config.adminUsers,
    directoryRole: directory ? directory.role : null
  });

  const isAdminUser = resolved.isAdmin;
  const roleSource = resolved.source;
  user.role = resolved.role;

  if (resolved.loginMatched && resolved.mis) {
    if (resolved.mis.name) {
      user.user_name = resolved.mis.name;
      user.first_name = resolved.mis.name.split(' ')[0] || 'User';
    }
    if (resolved.mis.dept) user.department = resolved.mis.dept;
  }

  user.role_source = roleSource;

  commands.setIdentityStatus({
    tokenReceived: !!String(body.identity_token ?? '').trim(),
    tokenValid: !!resolved.mis,
    loginMatched: resolved.loginMatched,
    misRole: resolved.mis ? resolved.mis.role : null,
    roleSource
  });

  if (commands.isDisabled()) {
    const isEnable = String(message ?? '').trim().toLowerCase() === '$enable';
    if (!(isAdminUser && isEnable)) {
      logEvent('info', 'chatbot_disabled', { user: quotaUser });
      return {
        status: 200,
        body: {
          reply: "Ami is currently switched off by an administrator. Please try again later, or contact MIS directly.",
          provider: 'system',
          mode: 'chat',
          disabled: true
        }
      };
    }
  }

  if (commands.isCommand(message)) {
    const cmdSession = conversationManager.getConversation(sessionId);
    cmdSession.user = { ...cmdSession.user, ...user };
    const cmdUserName = user.first_name || user.user_name || 'User';

    const result = await commands.handleCommand(String(message), {
      sessionId, session: cmdSession, user, userName: cmdUserName
    });
    if (result) {
      logEvent('info', 'command', { user: quotaUser, command: String(message).split(/\s+/)[0].toLowerCase() });
      return { status: 200, body: result as unknown as Record<string, unknown> };
    }
  }

  // Only a real turn is billed against the quota, not a command or a refusal.
  await limits.consume(quotaUser);

  ctx.isAdminUser = isAdminUser;
  return null;
};

// Stage 1 - who is calling.
//
// Establishes the caller's identity and nothing else. Everything downstream is
// allowed to assume ctx.user, ctx.quotaUser and ctx.sessionId are set, because
// this stage is the only thing that can end the turn before they are.

import { logEvent } from '../../core/logger';
import { db } from '../../db/storage.service';
import * as catalog from '../catalog';
import type { SessionUser } from '../../models/types.model';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';

export const NO_IDENTITY_MESSAGE =
  'Your MIS session has expired, so the assistant cannot identify you. Please sign in to the MIS helpdesk again, then reopen the chat.';

export const identify: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const { body, files } = ctx;
  const { session_id, message, user_name, user_email, user_department, login_user } = body;

  if (!session_id || (!message && files.length === 0)) {
    return { status: 400, body: { error: 'session_id and message (or file) required' } };
  }

  const userNameFromBody = String(user_name ?? '');
  const user: SessionUser = {
    user_name: userNameFromBody || 'User',
    email: String(user_email ?? ''),
    department: String(user_department ?? '') || 'MIS',
    role: 'user',
    first_name: userNameFromBody.split(' ')[0] || 'User',
    login: '',
    mis_user_id: ''
  };

  const loginId = String(login_user ?? '').trim();
  if (!loginId) {
    logEvent('warn', 'access_denied', { user: null, code: 'no_identity' });
    return { status: 401, body: { error: NO_IDENTITY_MESSAGE, code: 'no_identity' } };
  }
  const quotaUser = loginId;
  user.login = quotaUser;

  // MIS knows the authoritative name, employee number and e-mail for a login.
  // Everything the widget shows the user, and everything a ticket is filed
  // against, comes from here rather than from whatever the page happened to send.
  const mis = await catalog.misUser(quotaUser);
  if (mis) {
    if (mis.userId) user.mis_user_id = mis.userId;
    if (mis.lastName) user.last_name = mis.lastName;
    if (mis.fullName) {
      user.user_name = mis.fullName;
      user.first_name = mis.firstName || mis.fullName.split(' ')[0] || 'User';
    }
    if (mis.email) user.email = mis.email;
  }

  const sessionId = String(session_id);

  // Never fatal: a failure here means the caller is not registered yet, which
  // is not a reason to refuse the message.
  let storedUser = null;
  try {
    storedUser = await db().ensureUser({
      username: quotaUser,
      displayName: user.user_name,
      email: user.email,
      department: user.department
    });
  } catch (e) {
    console.warn(`[chat] ensureUser failed for ${quotaUser}: ${(e as Error).message}`);
  }

  ctx.user = user;
  ctx.quotaUser = quotaUser;
  ctx.sessionId = sessionId;
  ctx.storedUser = storedUser;
  return null;
};

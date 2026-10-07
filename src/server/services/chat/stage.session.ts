// Stage 3 - is this conversation still alive, and what do we call the user?
//
// Idle expiry is here rather than in the reply path because it can end the turn
// before any work is done. The nudge flag is awaited before the user is told
// anything: if a restart replayed the wrong half of the nudge, the user would be
// told to keep waiting right after being told to leave.

import conversationManager from '../session.service';
import { expireIfIdle } from '../session-lifecycle.service';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';

export const startSession: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const sessionId = ctx.sessionId as string;
  const user = ctx.user!;

  const session = conversationManager.getConversation(sessionId);
  session.user = { ...session.user, ...user };
  // A farewell waiting to be shown is a stale one: they are talking again.
  if (session.pending_goodbye) session.pending_goodbye = null;
  // Clear form_active - user is chatting again, so form is no longer in progress.
  if (session.form_active) delete session.form_active;

  // The user's message goes onto the transcript HERE, before the model is
  // called, and is written straight away.
  //
  // It used to be pushed by the LAST stage (decideAndStore), which meant anything
  // that ended the turn in between discarded it. A provider timeout or a quota
  // error returned from callModel, the pipeline stopped, and the user was told
  // "Sorry, I had trouble reaching the AI service" - and their message was never
  // stored. Reload, and the question they had just asked was gone. Given how
  // often the provider times out, that silently ate real turns.
  //
  // Saving here also means the transcript is truthful about what was asked, which
  // matters because the next turn's replay is built from it.
  if (ctx.message) {
    session.messages.push({
      role: 'user',
      content: ctx.message,
      timestamp: new Date().toISOString()
    });
    ctx.userTurnPushed = true;
    conversationManager.trimInMemory(sessionId);
    await conversationManager.saveConversation(sessionId);
  }
  const idleResult = expireIfIdle(sessionId, session);
  if (idleResult) {
    if (!session.nudge_sent) {
      session.nudge_sent = true;
      await conversationManager.saveConversation(sessionId);
      return { status: 200, body: { reply: idleResult, provider: 'system', mode: 'chat', ticket_created: false } };
    }
    session.nudge_sent = false;
    await conversationManager.saveConversation(sessionId);
    return { status: 200, body: { reply: idleResult, provider: 'system', mode: 'chat', ticket_created: false } };
  }
  session.nudge_sent = false;

  ctx.session = session;
  ctx.userName = user.first_name || user.user_name || 'User';
  return null;
};

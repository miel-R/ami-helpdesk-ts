// Stage 7 - decide whether to hand over to the ticket form, and store the turn.
//
// Two decisions live here because they are the same decision seen from two
// sides: what the user is told, and what the widget does next.
//
// The escalation marker is stripped from the reply here. The model emits it to
// signal a handover, and it must never reach the user as text.
//
// The persist call is AWAITED before responding. It used to be fire-and-forget,
// so a reload or a deploy between generating a reply and writing it lost the
// tail of the conversation - which is exactly the "my history is not retained"
// complaint. The user has now seen the answer, so the answer is on disk.

import conversationManager from '../session.service';
import {
  extractEscalation, hasDescribedProblem, resolveEscalation, buildTicketPrefill
} from '../../features/agent/escalation';
import { ami_userAskedForTicket } from '../../features/agent/ticket-intake';
import { sanitiseAiReply } from './sanitise.service';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';

export const decideAndStore: ChatStage = async (ctx: ChatContext): Promise<ChatResult | null> => {
  const session = ctx.session!;
  const sessionId = ctx.sessionId as string;
  const rawMessage = ctx.message;

  const { text: aiReplyClean, escalate: aiWantsEscalation } = extractEscalation(ctx.aiReply as string);

  // The user turn is NOT pushed here. startSession pushed and saved it before the
  // model was called, so a provider failure could not swallow it; doing it again
  // would duplicate every message in the transcript.
  if (!ctx.userTurnPushed && rawMessage) {
    session.messages.push({ role: 'user', content: rawMessage, timestamp: new Date().toISOString() });
  }

  const askedForTicket = ami_userAskedForTicket(rawMessage);

  // Everything the user has said this session, so triage can look back at the
  // earlier turns and not just the message in front of it.
  const userUtterances = session.messages
    .filter(m => m.role === 'user')
    .map(m => m.content);

  // Admins can order the form open; everyone else has to earn it by having
  // described a problem for Ami to assess first.
  const escalation = resolveEscalation({
    isAdmin: ctx.isAdminUser as boolean,
    askedForTicket,
    aiEscalates: aiWantsEscalation,
    userDescribedProblem: hasDescribedProblem(userUtterances)
  });

  const safeReply = sanitiseAiReply(aiReplyClean);
  // A blank reply is never shown blank. Each branch is the message that is
  // actually true given what the assistant has decided to do next.
  const usableReply = safeReply.trim()
    ? safeReply
    : (escalation.forceAssessment
      ? "Tell me what's happening and I'll take a look before we raise anything."
      : (askedForTicket
        ? "Sure - I'll bring up the form so you can log it."
        : "Sorry, I didn't catch that properly just now - my reply came back blank. Could you say that again?"));

  session.messages.push({ role: 'assistant', content: usableReply, timestamp: new Date().toISOString() });

  // The trim and the persistence cursor move together, in one place.
  //
  // It used to be a bare `messages.slice(-maxHistory * 2)` here, which left
  // `persistedCount` pointing past the end of the trimmed array. saveConversation
  // writes `messages.slice(persistedCount)`, so from the twentieth turn onward
  // that slice was empty and nothing was ever written again - silently, with no
  // error. Every message after the twentieth turn existed in the widget and was
  // gone on reload. See sessionManager.trimInMemory.
  conversationManager.trimInMemory(sessionId);

  await conversationManager.saveConversation(sessionId);

  return {
    status: 200,
    body: {
      reply: usableReply,
      provider: 'gemini',
      ticket_created: false,
      mode: 'chat',
      open_ticket_modal: escalation.open,
      // Carries the user's own words into the form so they do not retype a
      // problem they already explained here.
      ticket_prefill: escalation.open ? buildTicketPrefill(userUtterances) : undefined,
      attachments: [],
      uploads: (session as unknown as { uploads?: unknown[] }).uploads || [],
      last_file: ctx.lastFileName || null,
      options: undefined
    }
  };
};

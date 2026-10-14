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
import { getTicketModals, getLinksOnlyMode } from '../../config/ticket-modals.service';
import { TICKET_TYPE_LABELS } from '../../db/types.model';
import { sanitiseAiReply } from './sanitise.service';
import type { ChatContext, ChatResult, ChatStage } from './chat.pipeline';

/**
 * Whether a stored link can be turned into an anchor.
 *
 * Re-checked on read rather than trusted from the write path, because a row can
 * predate the admin API's validation. Only http(s) becomes a link: the widget's
 * renderer only linkifies those two schemes, so anything else stays as literal
 * text rather than becoming a javascript: href in every user's transcript.
 */
function isLinkableUrl(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

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

  // Ticket types an admin has switched off.
  //
  // A handover is only offered when there is something to hand over to. If every
  // type is disabled, opening the modal would show three dead ends, so the
  // handover is dropped and the links are sent into the chat instead.
  //
  // Links-only mode overrides all of that: no form opens for ANY type, so the
  // modal is suppressed regardless of how many types are enabled.
  //
  // Read BEFORE the reply text is composed, because the wording has to match what
  // the user is actually about to get.
  //
  // There is deliberately no admin bypass. An admin asking for a ticket gets the
  // same path as everyone else, because the switch exists to stop the chatbot
  // filing tickets MIS has not agreed to receive from it - that does not become
  // true because the requester happens to be an admin.
  const modalConfig = await getTicketModals();
  const linksOnly = await getLinksOnlyMode();
  const types = Object.entries(modalConfig);
  const enabledTypes = types.filter(([, v]) => v.enabled).map(([k]) => k);
  const handoffPossible = !linksOnly && enabledTypes.length > 0;
  const anyHandoff = linksOnly || enabledTypes.length > 0;

  const safeReply = sanitiseAiReply(aiReplyClean);
  // Fallbacks that promise a form are only true when a form is actually coming.
  // Otherwise a user who asked for a ticket and got "Sure - I'll bring up the
  // form" is told to expect a form that never opens.
  const usableReply = safeReply.trim()
    ? safeReply
    : (escalation.forceAssessment
      ? "Tell me what's happening and I'll take a look before we raise anything."
      : (askedForTicket
        ? (handoffPossible
          ? "Sure - I'll bring up the form so you can log it."
          : "Sure - you can raise it directly on the MIS form linked below.")
        : "Sorry, I didn't catch that properly just now - my reply came back blank. Could you say that again?"));

  // Wording differs by WHY the form is unavailable. "I can't file tickets here"
  // is wrong when only some types are off - the user may well be able to use the
  // form for the others.
  const finalReply = !anyHandoff
    ? `${usableReply}\n\nI can't file tickets here right now, so please use the MIS forms linked below.`
    : usableReply;

  // The MIS handovers, as real assistant turns.
  //
  // Persisted, not drawn by the browser. They used to be appended client-side,
  // which meant they disappeared on every refresh - the user asked for a ticket,
  // got the links, refreshed, and the transcript claimed no such thing was ever
  // said. A handover the user cannot point at in their own history is not a
  // handover.
  //
  // Written as markdown links because the widget already renders `[text](url)`
  // into an anchor with target=_blank and rel=noopener, and only for http(s).
  // So no widget-specific wire format is needed, and a URL that is not http(s)
  // degrades to plain text instead of becoming a clickable javascript: link.
  const offerLinks = (escalation.open || askedForTicket) && !handoffPossible;
  const linkMessages: string[] = [];
  if (offerLinks) {
    for (const [t, v] of types) {
      if (!linksOnly && v.enabled) continue;
      if (!isLinkableUrl(v.external_url)) continue;
      const label = TICKET_TYPE_LABELS[t] || t;
      linkMessages.push(
        `I don't file ${label} tickets here. Use the MIS form instead:\n` +
        `[Open the ${label} form](${v.external_url})`
      );
    }
  }

  // Which files this turn actually handed to the model, recorded on the reply.
  //
  // This is the record the dashboard's Files column reads. It is per-message
  // rather than per-conversation on purpose: `session.uploads` accumulates every
  // file for the life of the conversation (bounded at twenty), so counting from it
  // would report a screenshot uploaded in session #1 as "read" in session #5.
  const filesForMeta = (ctx.processedFiles || []).map(f => ({
    name: f.name,
    stored_name: f.stored_name,
    type: f.type || '',
    size: Number(f.size) || 0
  }));

  session.messages.push({
    role: 'assistant',
    content: finalReply,
    timestamp: new Date().toISOString(),
    // Empty meta is left off entirely rather than written as `{}`, so the common
    // no-upload turn produces exactly the row shape it always did.
    ...(filesForMeta.length ? { meta: { files: filesForMeta } } : {})
  });

  for (const linkText of linkMessages) {
    session.messages.push({
      role: 'assistant',
      content: linkText,
      timestamp: new Date().toISOString()
    });
  }

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
      reply: finalReply,
      provider: 'gemini',
      ticket_created: false,
      mode: 'chat',
      // Gated on there being something to hand over to.
      open_ticket_modal: escalation.open && handoffPossible,
      // The chat prints links whenever a ticket cannot be handed over as a form,
      // INCLUDING when the user explicitly asked for one and triage held them back.
      //
      // `escalation.open` alone was wrong here, and it was admin-only in effect:
      // resolveEscalation opens the form straight away for an admin but returns
      // open:false for an ordinary user who merely said "create a ticket", because
      // asking is not describing a problem. That is a sound rule for opening a
      // FORM - it forces a diagnosis first - but as a rule for OFFERING A LINK it
      // meant a normal user was shown nothing at all, while the admin testing the
      // same account saw the links and concluded it worked.
      //
      // Handing over the real MIS form is not the thing triage protects against:
      // that form does its own triage, and MIS validates it. So the link is offered
      // whenever the user asked and the modal is not the route.
      offer_ticket_links: offerLinks,
      // The exact strings just persisted, so the widget renders what was written
      // rather than rebuilding it and risking the two drifting apart.
      ticket_link_messages: linkMessages,
      // Carries the user's own words into the form so they do not retype a
      // problem they already explained here.
      ticket_prefill: escalation.open && handoffPossible ? buildTicketPrefill(userUtterances) : undefined,
      // Sent on every turn so the widget can render a link for a switched-off
      // type the moment the user picks it, without a second round trip.
      // Labels travel with the settings so the widget's link reads "Open the
      // System Request form" rather than "Open the system_request form".
      ticket_modals: Object.fromEntries(types.map(([t, v]) => [t, {
        enabled: v.enabled,
        external_url: v.external_url,
        label: TICKET_TYPE_LABELS[t] || t
      }])),
      // The master switch, sent beside the map rather than inside it, because it
      // is not a ticket type and the widget iterates that map.
      links_only: linksOnly,
      attachments: [],
      uploads: (session as unknown as { uploads?: unknown[] }).uploads || [],
      last_file: ctx.lastFileName || null,
      options: undefined
    }
  };
};

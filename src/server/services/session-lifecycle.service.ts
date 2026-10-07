// Closing a conversation that has gone quiet.

import { config } from '../config/config.service';
import type { Conversation } from '../models/types.model';

/**
 * The row written into `messages` when a session closes, so the end of a
 * conversation survives a reload.
 *
 * The divider used to be inferred: the server flagged `session_ended`, the widget
 * drew a divider, and reopening the widget showed the thread with the marker
 * inferred from live state. That marker was therefore lost the moment the state
 * was consumed - it existed for one page view, and a reload after five minutes
 * of quiet showed a thread that simply stopped mid-sentence with no explanation.
 *
 * Persisting it as a message row puts the boundary in the transcript itself, in
 * the right chronological position, so it renders on every load and a conversation
 * that has ended and been restarted twice shows two dividers where it should.
 *
 * `[ended session]` is a wire value: the widget matches on it to decide that a row
 * is a boundary rather than something to show as a bubble. Changing it means
 * changing the widget's check as well.
 */
export const SESSION_END_MARKER = '[ended session]';

/** Index of the most recent `[ended session]` row, or -1 when there is none. */
export function lastIndexOfMarker(messages: Array<{ role?: string; content?: string }>): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'system' && m.content === SESSION_END_MARKER) return i;
  }
  return -1;
}

export function expireIfIdle(
  sessionId: string,
  conv: Conversation,
  knownIdleSince?: number,
  knownHasContent?: boolean
): string | null {
  const bag = conv as unknown as { last_seen?: number; pending_goodbye?: string | null; nudge_sent?: boolean };
  const idleSince = Number(knownIdleSince ?? bag.last_seen ?? conv.lastActivity ?? 0);
  if (!idleSince) return null;

  const idleMs = Date.now() - idleSince;
  const hasContent = knownHasContent ?? (
    conv.messages.length > 0 ||
    conv.mode !== 'chat' ||
    Object.keys(conv.collected_fields || {}).length > 0
  );
  if (!hasContent || bag.pending_goodbye || idleMs <= config.conversation.sessionTimeout) {
    return null;
  }

  // The transcript is NOT cleared here.
  //
  // It used to be, and that is why reloading the page after a session ended
  // showed nothing: the history endpoint pages the persisted `messages` table,
  // but this reset the in-memory conversation and the flag that makes the next
  // message start a fresh thread, so the old transcript came back attached to a
  // conversation the server no longer considered open.
  //
  // Only the live state that must not leak into a new conversation is dropped.
  // The messages stay on disk (and in memory) so a reload shows the thread,
  // with the divider at the end, and the next message starts cleanly.
  conv.collected_fields = {};
  conv.ticket_draft = null;
  conv.ticket_type = null;
  conv.intake_stage = null;
  conv.pending_question = null;
  conv.type_attempts = 0;
  conv.submit_attempts = 0;
  (conv as unknown as Record<string, unknown>).last_asked_ticket = false;
  // Marks the conversation closed without discarding the record of it.
  conv.status = 'ended';
  conv.mode = 'chat';
  // A closed session IS greeted afresh next time - but only once the user
  // actually says something again, never on the history load that reports the end.
  //
  // This was `true`, which did the opposite: `greeted` is what suppresses the
  // greeting (see chat.controller, `else if (!bag.greeted)`), so setting it true
  // here meant that once a session had ever ended, that user was NEVER greeted
  // again for the life of the conversation - including after every subsequent
  // idle close. `false` re-arms the greeting for the new conversation.
  conv.greeted = false;
  bag.nudge_sent = false;

  const farewell = farewellFor(idleMs);
  bag.pending_goodbye = farewell;

  // The boundary goes into the transcript as a real row, so it is replayed on
  // every future load instead of being re-inferred from state that is consumed.
  //
  // `role: 'system'` keeps it out of the user/assistant dialogue, and it is
  // filtered out of the AI's replayed context as well (see stage.reply) so it is
  // never fed to the model as something the user said.
  //
  // Only marked when there is actual conversation since the last marker. Without
  // that rule a session that goes idle, is spoken to, and goes idle again writes a
  // marker every cycle, and an abandoned tab stacking them produced SEVEN dividers
  // in one thread - which then rendered as the entire visible transcript, because
  // the newest row was a divider and the transcript opens scrolled to the bottom.
  //
  // A boundary between two conversations means nothing when there is no second
  // conversation.
  const lastMarkerAt = lastIndexOfMarker(conv.messages);
  const sinceLastMarker = conv.messages
    .slice(lastMarkerAt + 1)
    .some(m => m.role === 'user' || m.role === 'assistant');
  if (sinceLastMarker) {
    conv.messages.push({
      role: 'system',
      content: SESSION_END_MARKER,
      timestamp: new Date().toISOString()
    });
  }

  console.log(`[session] ${sessionId} expired after ${Math.round(idleMs / 60000)}m idle; farewell queued`);
  return farewell;
}

/**
 * The farewell shown when a session ends on its own.
 */
export function farewellFor(idleMs: number): string {
  const mins = Math.max(1, Math.round(idleMs / 60000));
  return `Thanks for chatting! 👋 It's been about ${mins} minute${mins === 1 ? '' : 's'} `
    + `since we last spoke, so I've closed that conversation.\n\nAnything you were in the `
    + `middle of has not been sent to MIS. Just tell me again and we'll start a fresh one.`;
}

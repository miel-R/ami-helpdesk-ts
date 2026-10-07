// When the assistant hands the conversation over to the ticket form.

export const ESCALATION_MARKER = '[[OPEN_TICKET_MODAL]]';

/**
 * Pull the escalation signal out of a model reply.
 *
 * A marker on its own - or on a reply with nothing else in it - is treated as
 * noise rather than a handover request. A bare token means the model emitted the
 * marker without saying anything, and dropping an empty ticket form in front of
 * the user is worse than not opening one.
 */
export function extractEscalation(text: string): { text: string; escalate: boolean } {
  const raw = String(text ?? '');
  if (raw.indexOf(ESCALATION_MARKER) === -1) return { text: raw, escalate: false };
  const stripped = raw.split(ESCALATION_MARKER).join('').trim();
  return { text: stripped, escalate: stripped.length > 0 };
}

/**
 * Whether this history load should be the one that opens a conversation.
 *
 * Three things have to agree: the thread is empty, nothing on disk says we have
 * already greeted, and the live conversation does not either. The live check is
 * not redundant - the widget loads history more than once on boot, and the
 * persisted flag may not be written yet when the next request lands.
 */
export function shouldGreet(input: {
  messageCount: number;
  storedGreeted?: boolean;
  liveGreeted?: boolean;
}): boolean {
  return input.messageCount === 0 && input.storedGreeted !== true && input.liveGreeted !== true;
}

// ---------------------------------------------------------------------------
// Ticket handover: who may demand one, who has to earn one
// ---------------------------------------------------------------------------

/** Turns that are not a description of a problem, however they are phrased. */
const NON_DESCRIPTIVE = [
  /^\s*\$[a-z_]+\b/i,                                  // a command
  /^\s*(hi|hey|hello|good\s+(morning|afternoon|evening)|test|testing)\b/i,
  /^\s*(thanks|thank\s+you|ty|ok|okay|cool|great|perfect|noted|yes|no|sure|bye|goodbye)\b[\s!.]*$/i,
  /\b(create|make|file|open|raise|submit|send)\b.{0,20}\b(ticket|job\s*ticket|request)\b/i,
  /\b(ticket|job\s*ticket)\b.{0,20}\b(please|now|for\s+me)\b/i
];

/** A description has to carry a little substance, not just be long. */
const MIN_DESCRIPTIVE_LENGTH = 15;

/**
 * Whether the user has actually described something that can be troubleshot.
 *
 * Needed because "create a ticket" is not a problem statement. Without this a
 * normal user could skip diagnosis entirely by demanding the form, which is the
 * opposite of what triage is for.
 */
export function hasDescribedProblem(messages: readonly string[]): boolean {
  return messages.some((raw) => {
    const text = String(raw || '').trim();
    if (text.length < MIN_DESCRIPTIVE_LENGTH) return false;
    return !NON_DESCRIPTIVE.some(re => re.test(text));
  });
}

export interface EscalationDecision {
  /** Send the modal to the widget. */
  open: boolean;
  /** The reply should push the user to describe the problem / let Ami assess. */
  forceAssessment: boolean;
}

/**
 * Decide whether this turn hands over to the ticket form.
 *
 * Admins can command it: they know what they are doing and asking twice wastes
 * their time. Everyone else has to let Ami look at the problem first, so a normal
 * user's demand never opens the form on its own - Ami opens it once it has
 * assessed the situation and reached for the marker itself.
 */
export function resolveEscalation(input: {
  isAdmin: boolean;
  askedForTicket: boolean;
  aiEscalates: boolean;
  userDescribedProblem: boolean;
}): EscalationDecision {
  if (input.isAdmin) {
    // An admin who says "create a ticket" gets the form. No triage.
    return { open: input.askedForTicket || input.aiEscalates, forceAssessment: false };
  }

  // A normal user asking for a ticket has not, by asking, told us what is wrong.
  if (input.askedForTicket) return { open: false, forceAssessment: true };

  // Ami may only escalate something it has been told about.
  if (input.aiEscalates) {
    return input.userDescribedProblem
      ? { open: true, forceAssessment: false }
      : { open: false, forceAssessment: true };
  }

  return { open: false, forceAssessment: false };
}

export interface TicketPrefill {
  description: string;
  justification: string;
}

/**
 * Draft the request description from what the user already told us.
 *
 * The form should not ask someone to retype a problem they have already explained
 * in chat. We have the session, so we reuse the user's own words rather than
 * inventing a summary - a rewritten description is one they have to re-read and
 * correct before submitting.
 */
export function buildTicketPrefill(
  messages: readonly string[],
  opts: { maxChars?: number } = {}
): TicketPrefill {
  const maxChars = opts.maxChars ?? 900;
  const substantive = messages
    .map(m => String(m || '').trim())
    .filter(m => m.length >= MIN_DESCRIPTIVE_LENGTH && !NON_DESCRIPTIVE.some(re => re.test(m)));

  if (!substantive.length) return { description: '', justification: '' };

  const joined = substantive.join('\n');
  const description = joined.length > maxChars ? `${joined.slice(0, maxChars).trimEnd()}...` : joined;

  return {
    description,
    // Deliberately empty: justification is a judgement about why MIS should act,
    // and we have no business writing that for the user.
    justification: ''
  };
}

/**
 * Close a conversation that has been idle past the timeout.
 *
 * Returns the farewell text when this call is what closed the session, so the
 * caller can show it immediately.
 */
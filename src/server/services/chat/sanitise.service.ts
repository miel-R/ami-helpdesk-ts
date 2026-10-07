// Stripping two specific lies out of the model's reply before anyone reads it.
//
// Both guards exist because the MODEL produced the thing, not because a user
// typed it.
//
// The fabricated-ticket guard is the serious one. A user who believes their
// ticket is filed when it is not will stop asking for help, and the work will
// never get done. The UI guard is cosmetic by comparison, but "click the button
// below" from a chat window with no buttons below it is just wrong.

// "click the link", "select the option", "use the menu" - none of which exist
// in a chat panel.
const UI_REFERRAL = /\b(?:click|tap|press|select|choose|pick|use)\b.{0,30}\b(?:button|link|option|menu|form)\b/gi;
function guardUiHallucination(text: string): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(s => !UI_REFERRAL.test(s))
    .join(' ');
}

// Any reference number at all, in the shape MIS issues them.
const TICKET_NUMBER_TOKEN = /\b(?:ticket|control|reference|case|incident)\s*(?:number|#|id)?\s*[:=]?\s*[A-Z]{2,6}[-_]?\d{3,}\b/gi;
// "your ticket number", "the control id" - the phrasing of a real ticket.
const NUMBER_CLAIM_CONTEXT = /\b(?:your|the|a)\s+(?:ticket|control|reference|case|incident)\s+(?:number|#|id)\b/gi;
// "has been created", "was submitted" - the phrasing of a finished ticket.
const SUBMISSION_CLAIM = /\b(?:ticket|case|incident)\s+(?:created|submitted|filed|raised|opened|logged)\b/gi;

function guardFabricatedTicket(text: string): string {
  if (TICKET_NUMBER_TOKEN.test(text) || (NUMBER_CLAIM_CONTEXT.test(text) && SUBMISSION_CLAIM.test(text))) {
    return 'I apologize - I incorrectly stated a ticket was created. No ticket has been submitted. Let me help you properly.';
  }
  return text;
}

export function sanitiseAiReply(text: string): string {
  return guardUiHallucination(guardFabricatedTicket(text));
}

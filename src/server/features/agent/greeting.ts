// How the assistant opens and signs off a conversation.

export function greetingPeriod(timezone: string, now: Date = new Date()): 'morning' | 'afternoon' | 'evening' {
  let hour = now.getUTCHours();
  try {
    const parsed = Number(new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', hour12: false, timeZone: timezone
    }).format(now));
    if (Number.isFinite(parsed)) hour = parsed % 24;
  } catch {
  }
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
}

/**
 * The greeting a brand-new session opens with.
 */
export function greetingFor(name: string, timezone: string, now: Date = new Date()): string {
  const first = String(name || '').trim().split(/\s+/)[0] || 'there';
  return `Good ${greetingPeriod(timezone, now)}, ${first}! 👋\n\nI can help you troubleshoot tech issues or raise a MIS ticket. What can I help you with?`;
}

/**
 * Out-of-band signal the model emits to hand the conversation to the ticket form.
 *
 * The model cannot open the form, so it asks for the handover with this token and
 * the server turns it into a flag the widget acts on. It is an implementation
 * detail: it is stripped before the reply is sent or persisted, so it never
 * reaches the user or the transcript.
 */
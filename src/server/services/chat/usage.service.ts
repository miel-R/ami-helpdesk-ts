// Per-session token and cost totals, kept on the in-memory conversation.
//
// This is deliberately not persisted: it is a running tally for the admin
// dashboard, and the authoritative cost ledger is the usage_messages table.

import type { Conversation } from '../../models/types.model';

export interface SessionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
}

export function sessionUsage(session: Conversation): SessionUsage {
  const bag = session as unknown as { usage?: SessionUsage };
  if (!bag.usage) bag.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
  return bag.usage;
}

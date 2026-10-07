// The shape every storage caller codes against.
//
// Both backends implement all of it, so a missing method is a compile error rather
// than a runtime 500 discovered in production.

// ---------------------------------------------------------------------------
// Row and payload shapes
// ---------------------------------------------------------------------------

/** A users row. Field names mirror the table so SQL and JSON share one type. */
export interface UserRecord {
  username: string;
  display_name: string;
  email: string;
  department: string;
  role: string;
  enabled: boolean;
  /** null means "inherit the server default", not "zero". */
  requests_per_day: number | null;
  max_upload_bytes: number | null;
  note: string;
  created_at: string;
  last_seen: string;
  updated_at?: string;
}

/**
 * A settings patch.
 *
 * `undefined` means "field not supplied, leave it alone"; `null` means "clear
 * the override and go back to inheriting". The distinction is load-bearing, so
 * the type has to allow both explicitly.
 */
export interface UserPatch {
  role?: string;
  enabled?: boolean;
  requests_per_day?: number | string | null;
  max_upload_bytes?: number | string | null;
  note?: string | null;
}

/** Identity fields accepted when registering someone. Admin fields are ignored. */
export interface UserProfile {
  username: string;
  displayName?: string;
  email?: string;
  department?: string;
}

/** One row of the token/cost ledger. */
export interface UsageEntry {
  id: number;
  session_id: string;
  username: string;
  kind: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
  created_at: string;
}

/** What recordMessage() accepts. Naming is camelCase here, snake_case on rows. */
export interface UsageEntryInput {
  sessionId?: string;
  username?: string;
  kind?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  createdAt?: string | null;
}

/** Metadata stored alongside a conversation, mirroring the DB columns. */
export interface ConversationStateMeta {
  username: string;
  mode: string;
  status: string;
  controlNumber: string | null;
  uploads: unknown[];
  messageCount: number;
}

/** A stored conversation as the admin list and history routes see it. */
export interface ConversationRow {
  session_id: string;
  username: string;
  mode: string;
  status: string;
  control_number: string | null;
  uploads: unknown[];
  state: Record<string, unknown>;
  message_count: number;
  created_at: string | null;
  updated_at: string | null;
  last_message_at: string | null;
}

/** What getConversationState() returns; null when the session is unknown. */
export interface ConversationState {
  state: Record<string, unknown>;
  mode: string;
  status: string;
  control_number: string | null;
  uploads: unknown[];
  username: string;
}

/** A page of stored messages, newest-first, with a cursor for the next page. */
export interface MessagePage {
  messages: Array<Record<string, unknown>>;
  has_more: boolean;
  next_before: number | null;
}

/** One grouped row of the usage summary. */
export interface SummaryBucket {
  k: string;
  calls: number;
  input: number;
  output: number;
  cost: number;
  last_at?: string | null;
}

export interface UsageSummary {
  days: number;
  input: number;
  output: number;
  total: number;
  cost: number;
  calls: number;
  byDay: SummaryBucket[];
  byModel: SummaryBucket[];
  byUser: SummaryBucket[];
  bySession: SummaryBucket[];
}

export interface ListConversationsOptions {
  limit?: number;
  username?: string | null;
}

export interface PageMessagesOptions {
  limit?: number;
  before?: string | number | null;
}

export interface ListMessagesOptions {
  sessionId?: string | null;
  username?: string | null;
  limit?: number;
}

export interface SummaryOptions {
  days?: number;
  username?: string | null;
}

/** What a stored message looks like on the way in and out. */
export interface StoredMessage {
  role?: string;
  content?: string;
  createdAt?: string | null;
  meta?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** The row shape both conversation-listing backends agree on. */
export type StoredConversationRow = ConversationRow & Record<string, unknown>;

/**
 * The contract every caller codes against. Both backends implement all of it,
 * so a missing method is a compile error rather than a runtime 500.
 */
/** One conversation save: the new messages plus the state they belong to. */
export interface ConversationPersistInput {
  sessionId: string;
  username?: string;
  /** Only the messages not yet written. Sending more would duplicate them. */
  messages?: StoredMessage[];
  state?: Record<string, unknown>;
  meta?: Partial<ConversationStateMeta>;
}

export interface ConversationPersistResult {
  appended: number;
  /**
   * Highest message id already stored for this session, read inside the same
   * transaction. The caller keeps this as its high-water mark, which is what
   * makes the cursor self-healing: a write that fails can never leave the
   * caller believing it succeeded, and a message whose id is below the mark is
   * simply re-sent.
   */
  lastMessageId: number;
}

/** Outcome of a real storage round-trip, as opposed to a liveness guess. */
export interface StorageHealth {
  ok: boolean;
  /** Tables the app cannot run without. Missing any of these is fatal. */
  missing: string[];
  /** Present, or a real query failed. */
  error?: string;
  /** Cheap proof the schema is reachable and readable, not just declared. */
  conversations?: number;
  messages?: number;
}

/** What a caller can report without knowing which backend is active. */
export const REQUIRED_TABLES = ['users', 'conversations', 'messages'] as const;

export interface StorageBackend {
  readonly kind: 'postgres' | 'json';

  init(): Promise<void>;

  /**
   * Prove the backend can actually read the data this app depends on.
   *
   * Added because "the process is up" and "the app works" are different claims.
   * A database whose tables were dropped kept this server answering /api/health
   * with `status: ok` while every catalog, history and ticket call failed with
   * `relation "conversations" does not exist`. Monitoring watched a green light
   * through a total outage. A health check that does not touch storage cannot
   * catch that class of failure, so this one counts the rows it depends on.
   */
  health(): Promise<StorageHealth>;

  ensureUser(profile: UserProfile): Promise<UserRecord | null>;
  getUser(username: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  updateUser(username: string, patch?: UserPatch): Promise<UserRecord | null>;
  deleteUser(username: string): Promise<boolean>;

  getRequestUsage(username: string, day?: string): Promise<number>;
  consumeRequest(username: string, day?: string): Promise<number>;

  recordMessage(entry?: UsageEntryInput): Promise<UsageEntry>;
  listMessages(options?: ListMessagesOptions): Promise<UsageEntry[]>;
  summary(options?: SummaryOptions): Promise<UsageSummary>;

  saveConversationState(
    sessionId: string,
    state?: Record<string, unknown>,
    meta?: Partial<ConversationStateMeta>
  ): Promise<void>;
  appendMessages(sessionId: string, username: string, messages?: StoredMessage[]): Promise<number>;

  /**
   * Append messages and write conversation state as ONE unit of work.
   *
   * The two are not independent. Both touch the same `conversations` row:
   * appendMessages increments `message_count` by the number appended, while
   * saveConversationState overwrites it from the in-memory length. Run as two
   * separate pooled statements they interleave freely, so the count ends up
   * wrong and the conversation row can disagree with the messages table.
   *
   * Saving one way or the other is also wrong: state-only writes would drop any
   * messages not yet appended, and message-only writes would lose the `greeted`
   * flag and the idle bookkeeping that make history load correctly after a
   * reload. This is the single write path the conversation layer uses.
   */
  persistConversation(input: ConversationPersistInput): Promise<ConversationPersistResult>;
  getConversationState(sessionId: string): Promise<ConversationState | null>;
  listConversations(options?: ListConversationsOptions): Promise<StoredConversationRow[]>;
  pageMessages(sessionId: string, options?: PageMessagesOptions): Promise<MessagePage>;
  recentMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
  deleteConversation(sessionId: string): Promise<void>;

  pruneOldMessages(days?: number): Promise<number>;
  close(): Promise<void>;
}
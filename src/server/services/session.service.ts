// Conversation state management
import { config } from '../config/config.service';
import * as store from '../db/storage.service';
import type { MessagePage, StoredMessage } from '../db/storage.service';
import type { Conversation, Message, PendingQuestion, TicketType } from '../models/types.model';

/** Metadata stored alongside a conversation, mirroring the DB columns. */
export interface ConversationMeta {
  username: string;
  mode: string;
  status: string;
  controlNumber: string | null;
  uploads: unknown[];
  messageCount: number;
}

/** Paging options for a history page. */
export interface PageOptions {
  limit?: number;
  before?: string | null;
}

/**
 * A page of stored messages.
 *
 * Deliberately re-exported from the storage layer rather than redeclared here:
 * the shape is the JSON the widget receives, so it has to be the exact same
 * type the backend returns, not a parallel definition that can drift.
 */
export type { MessagePage } from '../db/storage.service';

/** In-memory ticket quota counter for one user. */
interface RateWindow {
  count: number;
  windowStart: number;
}

/**
 * Conversations are cached in memory for AI context, but persistence goes through
 * the storage backend (Postgres, or the JSON fallback). Messages are appended
 * individually so a long thread can be paginated; the rest of the ticket-intake
 * state is saved as a single blob against the session.
 */
class ConversationManager {
private conversations = new Map<string, Conversation>();

/**
 * Tail of each session's write chain.
 *
 * Serialising per session is what stops two concurrent requests writing the
 * same conversation from losing one another's messages. Kept separate from the
 * conversation objects because it is process-local ordering, not conversation
 * state, and must never be persisted.
 */
private writeQueue = new Map<string, Promise<void>>();
  private userRateLimits = new Map<string, RateWindow>();
  private serverStartedAt = Date.now();

  /** Delete a conversation from memory and from storage. */
  deleteConversation(sessionId: string): void {
    this.conversations.delete(sessionId);
    try {
      void store.db().deleteConversation(sessionId);
    } catch (e) {
      console.warn(`[history] could not delete ${sessionId}: ${(e as Error).message}`);
    }
  }

  /** Get or create a conversation, restoring from storage if needed. */
  getConversation(sessionId: string, opts?: { peek?: boolean }): Conversation {
    if (!this.conversations.has(sessionId)) {
      const fresh: Conversation = {
        session_id: sessionId,
        user: {
          user_name: 'User',
          email: '',
          department: 'MIS',
          role: 'user',
          first_name: 'User'
        },
        messages: [],
        attachments: [],
        uploads: [],
        mode: 'chat',
        ticket_type: null as unknown as TicketType,
        collected_fields: {},
        intake_stage: null,
        pending_question: null as PendingQuestion | null,
        status: 'active',
        last_control_number: null,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        // Persisted (unlike lastActivity) so an idle conversation can still be
        // recognised as idle after the process restarts.
        last_seen: Date.now(),
        // How many entries of conv.messages are already in storage, so
        // saveConversation only ever appends what is new.
        persistedCount: 0,
        restored: false
      };
      this.conversations.set(sessionId, fresh);
    }

    const conv = this.conversations.get(sessionId) as Conversation;
    if (!opts?.peek) {
      conv.lastActivity = Date.now();
      (conv as Record<string, unknown>).last_seen = conv.lastActivity;
      // Marks this conversation as genuinely used, not merely opened.
      //
      // The restore runs asynchronously and copies the stored `last_seen` back
      // over the top, which used to rewind a live clock to the pre-restart
      // timestamp. This flag is how restore() knows a real request has already
      // claimed this conversation. See restore().
      (conv as Record<string, unknown>).touched = true;
    }

    // Restore from storage exactly once.
    if (!conv.restored) {
      conv.restored = true;
      this.restore(sessionId, conv);
    }

    return conv;
  }

  /**
   * Rebuild a conversation from storage.
   *
   * Fire-and-forget, so it races with the first request that triggered it. It
   * used to REPLACE conv.messages wholesale and reset the cursor, which meant a
   * save running alongside it either lost the message it had just pushed or was
   * followed by a re-append of the restored ones - the transcript grew duplicate
   * turns. Two things make it safe now:
   *
   *   - restored messages are put at the FRONT, leaving anything added while the
   *     read was in flight intact at the end, where it belongs;
   *   - saveConversation awaits this promise before taking its snapshot, so a
   *     save can never race the restore it depends on.
   */
  restore(sessionId: string, conv: Conversation): void {
    const bag = conv as unknown as Record<string, unknown>;
    try {
      const backend = store.db();

      const done = Promise.all([
        backend.getConversationState(sessionId),
        backend.recentMessages(sessionId, config.conversation.maxHistory)
      ])
        .then(([row, recent]) => {
          if (row) {
            const saved = (row.state ?? {}) as Record<string, unknown>;
            // Drop any stale runtime bookkeeping that an older build persisted,
            // so it cannot resurrect a cursor that disagrees with the messages
            // table. It is re-derived below from what is actually there.
            delete saved.persistedCount;
            delete saved.restored;
            // Same for the two flags saveConversation no longer writes, in case a
            // row was written by a build that still persisted them. A stale
            // `form_active: true` here would make the sweep skip the session
            // forever.
            delete saved.form_active;
            delete saved.touched;
            // `last_seen` is taken from storage ONLY when nothing has touched this
            // conversation since the process started.
            //
            // getConversation sets `last_seen = now` when it creates the object,
            // and a real request (any non-peek call) moves it forward again. The
            // restore is asynchronous, so copying the stored value back over the
            // top unconditionally rewound a LIVE clock to the pre-restart
            // timestamp: come back after a 6-minute deploy with a 5-minute
            // timeout and the next sweep expired a session the user was actively
            // using, writing the divider and wiping `collected_fields` mid-intake.
            //
            // The guard is deliberately one-sided. A pure history read also
            // creates the conversation, and it must NOT keep a stale session
            // alive: without the stored value winning there, an old session
            // reloaded by the user would look brand new and never expire.
            if (!bag.touched && saved.last_seen !== undefined) {
              bag.last_seen = Number(saved.last_seen) || Date.now();
            }
            delete saved.last_seen;
            for (const key of Object.keys(saved)) {
              bag[key] = saved[key];
            }
            conv.mode = (row.mode as Conversation['mode']) || conv.mode;
            conv.status = (row.status as Conversation['status']) || conv.status;
            conv.uploads = Array.isArray(row.uploads) ? row.uploads : conv.uploads;
            conv.last_control_number =
              row.control_number !== undefined ? row.control_number : conv.last_control_number;
          }
          const stored = Array.isArray(recent) ? recent : [];
          if (stored.length) {
            // Stored rows carry an optional role, but the domain type demands a
            // real one. Anything unrecognised is treated as a user turn rather
            // than dropped, so no history is silently lost on restore.
            const older = stored.map(m => ({
              role: (m.role === 'assistant' || m.role === 'system' ? m.role : 'user') as Message['role'],
              content: String(m.content ?? '')
            }));
            // Anything already in memory was pushed after this read started, so
            // it is newer and stays after the restored block.
            const inMemory = conv.messages.slice();
            conv.messages = [...older, ...inMemory];
            // Only the restored prefix is on disk. The cursor is set even when
            // nothing was restored, which is what lets a conversation whose rows
            // were lost start saving again instead of staying frozen forever.
            bag.persistedCount = older.length;
            console.log(`[history] restored ${older.length} messages for ${sessionId}`);
          } else {
            bag.persistedCount = 0;
          }
        })
        .catch(e => {
          console.warn(`[history] could not restore ${sessionId}: ${(e as Error).message}`);
        });

      bag.restorePromise = done;
      // Nothing downstream should ever see an unhandled rejection from this.
      void done.catch(() => { /* logged above */ });
    } catch (e) {
      console.warn(`[history] could not restore ${sessionId}: ${(e as Error).message}`);
      bag.restorePromise = Promise.resolve();
    }
  }
  /**
   * Trim the in-memory transcript to the replay window, keeping the persistence
   * cursor in step with it.
   *
   * This exists because the trim used to be inlined in stage.escalate:
   *
   *   if (session.messages.length > maxHistory * 2) {
   *     session.messages = session.messages.slice(-maxHistory * 2);
   *   }
   *
   * which silently destroyed every message after the twentieth turn. The cursor
   * `persistedCount` means "how many of conv.messages are already on disk", and
   * saveConversation writes `messages.slice(persistedCount)`. Trimming the array
   * without moving the cursor left the cursor at 40 with a 40-long array, so that
   * slice was empty: the two messages just pushed were never written, and the
   * cursor stayed at 40 for every subsequent turn. Not one log line, and no error
   * - the transcript looked correct in the widget and vanished on reload. This is
   * the "my history is not retained" report.
   *
   * Trimming and cursor bookkeeping now live together so the two cannot drift.
   */
  trimInMemory(sessionId: string, keep = config.conversation.maxHistory * 2): number {
    const conv = this.conversations.get(sessionId);
    if (!conv) return 0;
    const bag = conv as unknown as Record<string, unknown>;
    const excess = conv.messages.length - keep;
    if (excess <= 0) return 0;
    conv.messages = conv.messages.slice(-keep);
    // Only the messages that were still unwritten can be dropped without loss; a
    // cursor already past `keep` means everything still pending has been trimmed.
    bag.persistedCount = Math.max(0, Number(bag.persistedCount ?? 0) - excess);
    return excess;
  }

  /**
   * Persist new messages plus the current ticket-intake state.
   *
   * Returns a promise and must be awaited by anything that needs the write to
   * have landed - notably /api/chat before it responds. It previously returned
   * void and fired an un-awaited async IIFE, so a deploy could drop the tail of
   * a conversation and the `greeted` flag with nothing reporting the loss.
   *
   * Writes for one session are chained onto a per-session queue. Two requests
   * touching the same conversation at the same time would otherwise both read
   * the same persisted copy and the later write would silently drop the
   * earlier one's messages - a lost update, which is the bug this replaced.
   */
  saveConversation(sessionId: string): Promise<void> {
    const conv = this.conversations.get(sessionId);
    if (!conv) return Promise.resolve();

    // Wait for the restore this conversation may still be running. Snapshotting
    // before it lands is what produced duplicate turns: the cursor was read from
    // a pre-restore value, so the next save re-sent messages the restore had
    // already put back into the array.
    const bag = conv as unknown as Record<string, unknown>;
    const restoring = bag.restorePromise as Promise<unknown> | undefined;

    const task = async (): Promise<void> => {
      // Inside the queue on purpose, so this is strictly ordered against both
      // the restore and any other save for this session.
      if (restoring) { try { await restoring; } catch { /* logged in restore */ } }

      const raw = Number(bag.persistedCount ?? 0);
      const startAt = Number.isFinite(raw) && raw > 0 ? Math.min(raw, conv.messages.length) : 0;
      const pending = conv.messages.slice(startAt).map(m => ({ ...m })) as StoredMessage[];
      // Reserve before awaiting the write. The next queued save reads the cursor
      // after this task yields, so it will not re-send these; if this write
      // fails, the reservation is rolled back so they are retried instead.
      bag.persistedCount = startAt + pending.length;

      const {
        messages: _messages,
        persistedCount: _persistedCount,
        restored: _restored,
        lastActivity: _lastActivity,
        restorePromise: _restorePromise,
        // Runtime-only, and deliberately NOT persisted.
        //
        // `form_active` describes what the user is doing RIGHT NOW - the ticket
        // form is open - not part of the conversation. It used to ride along in
        // the state blob, which meant a clean redeploy (the SIGTERM flush saves
        // every conversation) wrote `form_active: true` to disk and restore() put
        // it back. The idle sweep skips flagged sessions forever, so that session
        // could never expire again: it stayed `active`, held its whole transcript
        // in memory indefinitely, and showed as permanently active on /api/health
        // and the dashboard. Only a chat turn or a ticket submit cleared it.
        form_active: _formActive,
        // Set when a real request touched this conversation (see getConversation).
        // Runtime bookkeeping, so it must not survive a restart either.
        touched: _touched,
        ...state
      } = conv as Conversation & Record<string, unknown>;
      const meta: ConversationMeta = {
        username: (conv.user && (conv.user.user_name || conv.user.email)) || '',
        mode: String(conv.mode),
        status: String(conv.status),
        controlNumber: conv.last_control_number ?? null,
        uploads: conv.uploads ?? [],
        messageCount: conv.messages.length
      };

      try {
        const result = await store.db().persistConversation({
          sessionId,
          username: meta.username,
          messages: pending,
          state,
          meta
        });
        if (Number.isFinite(result.lastMessageId)) {
          bag.lastStoredMessageId = result.lastMessageId;
        }
      } catch (e) {
        // Roll the reservation back so a later save retries the same messages.
        // Losing a message is worse than writing one twice, and a duplicated
        // turn is visible in the transcript while a lost one is not.
        bag.persistedCount = startAt;
        console.warn(`[history] could not save ${sessionId}: ${(e as Error).message}`);
      }
    };

    const prev = this.writeQueue.get(sessionId) || Promise.resolve();
    // The queue must survive a failure in one link, or every later save for that
    // session would be skipped forever.
    const next = prev.then(task, task);
    this.writeQueue.set(sessionId, next);
    return next;
  }

  /**
   * Wait for every queued write to finish.
   *
   * Called on SIGTERM before the process exits, which is what makes a deploy or
   * restart non-destructive. Without it the last write or two of every session
   * was dropped on every deploy.
   */
  async flushWrites(): Promise<void> {
    const pending = [...this.writeQueue.values()];
    this.writeQueue.clear();
    if (!pending.length) return;
    await Promise.allSettled(pending);
  }

  /** Write anything still unsaved for these sessions, then wait for it. */
  async flushSessions(sessionIds: readonly string[]): Promise<void> {
    for (const id of sessionIds) {
      try { await this.saveConversation(id); } catch { /* already logged */ }
    }
    await this.flushWrites();
  }

  /**
   * Newest-first page of persisted messages, for the widget's
   * "load earlier messages" control.
   */
  async pageMessages(sessionId: string, { limit = 10, before = null }: PageOptions = {}): Promise<MessagePage> {
    return store.db().pageMessages(sessionId, { limit, before });
  }

  /** Read-only check: may this person open another ticket today? */
  canCreateTicket(userName: string): boolean {
    return this.getRateLimit(userName).count < config.rateLimit.perDay;
  }

  /** Consume ticket quota, only on successful ticket creation. */
  consumeTicketQuota(userName: string): void {
    this.getRateLimit(userName).count++;
  }

  /** Get the rate-limit window for a user, creating or rolling it over as needed. */
  getRateLimit(userName: string): RateWindow {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    if (!this.userRateLimits.has(userName)) {
      this.userRateLimits.set(userName, { count: 0, windowStart: now });
    }
    const limit = this.userRateLimits.get(userName) as RateWindow;
    if (now - limit.windowStart > dayMs) {
      limit.count = 0;
      limit.windowStart = now;
    }
    return limit;
  }

  /**
   * Mark the form as active for a session, so the idle sweep won't expire it.
   *
   * Two things have to happen here, and the first version of this method got the
   * first one wrong:
   *
   *   1. `last_seen` must move forward. The sweep expires on `last_seen`, and the
   *      flag only lives in memory, so a request that set the flag without
   *      touching the clock would still expire the session the moment the flag was
   *      lost - or, worse, be restored from storage after a restart already
   *      overdue. It called `getConversation(id, { peek: true })`, which by
   *      definition does NOT touch.
   *   2. It must work for a session that is not in the cache yet. The ticket form
   *      can be the very first thing a user does, before any chat turn has created
   *      a conversation in this process. The old early `return` meant that case
   *      silently did nothing: no clock, no flag, and the session expired
   *      underneath an open form.
   */
  markFormActive(sessionId: string): void {
    const conv = this.getConversation(sessionId);
    conv.form_active = true;
  }

  getAllConversations(): Map<string, Conversation> {
    return this.conversations;
  }

  /**
   * True when this conversation is already held in memory, without creating one.
   *
   * The unauthenticated history endpoint uses it to avoid turning arbitrary ids
   * into cache entries: `getConversation` creates a Conversation for whatever it
   * is given and fires a restore (two Postgres queries), so a loop over random
   * ids grew the map permanently and doubled the query load.
   */
  has(sessionId: string): boolean {
    return this.conversations.has(sessionId);
  }

  /**
   * Drop in-memory conversations that are long finished.
   *
   * Nothing removed an entry except `$reset`, so a long-running container
   * accumulated every session it had ever seen - each holding up to the replay
   * window of messages, its uploads and a retained restore promise. The idle
   * sweep walks the whole map on every tick, so its per-tick cost grew with
   * lifetime traffic rather than with live load.
   *
   * Called from the sweep, so it runs on a conversation that has already been
   * idle well past the timeout. Two guards matter:
   *
   *   - a queued write is never dropped, or the last turns of that conversation
   *     would be lost on the floor;
   *   - `lastActivity` rather than `last_seen`, because a session can sit idle
   *     for hours legitimately - someone reading before answering - and must
   *     come back intact when they do.
   *
   * `keepMs` defaults to twice the idle timeout, which is comfortably past the
   * point where anyone could still resume without a fresh greeting.
   */
  evictIdle(keepMs = config.conversation.sessionTimeout * 2): number {
    const cutoff = Date.now() - keepMs;
    let dropped = 0;
    for (const [id, conv] of this.conversations) {
      if (this.writeQueue.has(id)) continue;
      if (conv.status === 'active' && conv.form_active) continue;
      const lastUsed = Math.max(Number(conv.lastActivity || 0), 0);
      if (!lastUsed || lastUsed > cutoff) continue;
      this.conversations.delete(id);
      dropped++;
    }
    if (dropped) {
      console.log(`[history] evicted ${dropped} idle conversation(s) from memory`);
    }
    return dropped;
  }

  getServerStartedAt(): number {
    return this.serverStartedAt;
  }

  getUserRateLimits(): Map<string, RateWindow> {
    return this.userRateLimits;
  }
}

/** The manager is a singleton: the whole server shares one in-memory cache. */
const conversationManager = new ConversationManager();
export default conversationManager;

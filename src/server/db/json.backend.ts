// The JSON fallback backend.
//
// Used when DATABASE_URL is empty or Postgres cannot be reached, so a database
// outage never takes the chat down. It is a short-lived safety net rather than
// the system of record, which is why pruning is a no-op here.

import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { config } from '../config/config.service';
import type {
  ConversationPersistInput, ConversationPersistResult, StorageBackend, StorageHealth,
  StoredMessage, StoredConversationRow, ConversationState, ConversationStateMeta,
  ListConversationsOptions, PageMessagesOptions, MessagePage,
  UserRecord, UserPatch, UserProfile, UsageEntry, UsageEntryInput,
  SummaryBucket, UsageSummary, ListMessagesOptions, SummaryOptions
} from './types.model';
import { num, today, round10, limitValue, readJsonSync, writeJsonAtomic } from './helpers';

const USAGE_FILE = path.join(config.paths.dataDir, 'usage.json');
const USERS_FILE = path.join(config.paths.dataDir, 'users.json');
const MAX_LEDGER_ENTRIES = 20000;

// ---------------------------------------------------------------------------
// JSON backend (fallback)
// ---------------------------------------------------------------------------

/** On-disk shape of usage.json. */
interface UsageFile {
  entries: UsageEntry[];
  requests: Record<string, { day: string; count: number }>;
}

/** On-disk shape of users.json. */
interface UsersFile {
  users: Record<string, UserRecord>;
}

/** On-disk shape of one conversation file. */
interface ConversationFile {
  messages?: StoredMessage[];
  mode?: string;
  status?: string;
  last_control_number?: string | null;
  uploads?: unknown[];
  user?: Record<string, unknown>;
  createdAt?: number | string;
  lastActivity?: number | string;
  [extra: string]: unknown;
}

export class JsonBackend implements StorageBackend {
  readonly kind = 'json' as const;
  private usage!: UsageFile;
  private users!: UsersFile;

  async init(): Promise<void> {
    await fsp.mkdir(config.paths.dataDir, { recursive: true });
    this.usage = readJsonSync<UsageFile>(USAGE_FILE, { entries: [], requests: {} });
    this.users = readJsonSync<UsersFile>(USERS_FILE, { users: {} });
    if (!Array.isArray(this.usage.entries)) this.usage.entries = [];
    if (!this.usage.requests || typeof this.usage.requests !== 'object') this.usage.requests = {};
    if (!this.users.users || typeof this.users.users !== 'object') this.users.users = {};
    console.log(`[db] JSON fallback backend active (${USAGE_FILE})`);
  }

  /**
   * The JSON backend has no tables, so the equivalent check is that the
   * directories and files it needs are present and readable. Reported as
   * healthy with an empty `missing` list, because "the table is missing" has no
   * meaning here - only "the storage is unusable" does.
   */
  async health(): Promise<StorageHealth> {
    try {
      await fsp.access(config.paths.dataDir, fs.constants.R_OK);
      let conversations = 0;
      let messages = 0;
      try {
        const files = await fsp.readdir(path.join(config.paths.dataDir, 'conversations'));
        conversations = files.filter(f => f.endsWith('.json')).length;
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          try {
            const raw = JSON.parse(
              await fsp.readFile(path.join(config.paths.dataDir, 'conversations', f), 'utf8')
            ) as { messages?: unknown };
            if (Array.isArray(raw.messages)) messages += raw.messages.length;
          } catch { /* one unreadable file must not fail the whole check */ }
        }
      } catch { /* no conversations directory yet is fine on a fresh install */ }
      return { ok: true, missing: [], conversations, messages };
    } catch (e) {
      return {
        ok: false,
        missing: [],
        error: `data directory ${config.paths.dataDir} unusable: ${(e as Error).message}`
      };
    }
  }

  // -- users ---------------------------------------------------------------

  async ensureUser(profile: UserProfile = { username: '' }): Promise<UserRecord | null> {
    const username = String(profile.username || '').trim();
    if (!username) return null;
    const existing = this.users.users[username];
    if (existing) {
      // Keep identity fields fresh, but never let the client overwrite the
      // admin-controlled fields (role/enabled/limits).
      existing.display_name = profile.displayName || existing.display_name || username;
      existing.email = profile.email || existing.email || '';
      existing.department = profile.department || existing.department || '';
      existing.last_seen = new Date().toISOString();
      await writeJsonAtomic(USERS_FILE, this.users);
      return existing;
    }
    const rec: UserRecord = {
      username,
      display_name: profile.displayName || username,
      email: profile.email || '',
      department: profile.department || '',
      role: 'user',
      enabled: true,
      requests_per_day: null,
      max_upload_bytes: null,
      note: '',
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString()
    };
    this.users.users[username] = rec;
    await writeJsonAtomic(USERS_FILE, this.users);
    return rec;
  }

  async getUser(username: string): Promise<UserRecord | null> {
    return this.users.users[username] || null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return Object.values(this.users.users);
  }

  async updateUser(username: string, patch: UserPatch = {}): Promise<UserRecord | null> {
    const rec = this.users.users[username];
    if (!rec) return null;
    if (patch.role) rec.role = patch.role === 'admin' ? 'admin' : 'user';
    if (patch.enabled !== undefined) rec.enabled = !!patch.enabled;
    if (patch.requests_per_day !== undefined) rec.requests_per_day = limitValue(patch.requests_per_day);
    if (patch.max_upload_bytes !== undefined) rec.max_upload_bytes = limitValue(patch.max_upload_bytes);
    if (patch.note !== undefined) rec.note = String(patch.note || '');
    rec.updated_at = new Date().toISOString();
    await writeJsonAtomic(USERS_FILE, this.users);
    return rec;
  }

  async deleteUser(username: string): Promise<boolean> {
    delete this.users.users[String(username)];
    await writeJsonAtomic(USERS_FILE, this.users);
    return true;
  }

// -- request quota -------------------------------------------------------

  private requestsFor(username: string, day: string): { day: string; count: number } {
    const bucket = this.usage.requests[username];
    if (!bucket || bucket.day !== day) return { day, count: 0 };
    return bucket;
  }

  async getRequestUsage(username: string, day: string = today()): Promise<number> {
    return num(this.requestsFor(username, day).count);
  }

  async consumeRequest(username: string, day: string = today()): Promise<number> {
    const bucket = this.requestsFor(username, day);
    bucket.count = num(bucket.count) + 1;
    this.usage.requests[username] = bucket;
    await writeJsonAtomic(USAGE_FILE, this.usage);
    return bucket.count;
  }

  // -- token / cost ledger -------------------------------------------------

  async recordMessage(entry: UsageEntryInput = {}): Promise<UsageEntry> {
    const input = num(entry.inputTokens);
    const output = num(entry.outputTokens);
    const rec: UsageEntry = {
      id: Date.now() + Math.random(),
      session_id: String(entry.sessionId || ''),
      username: String(entry.username || ''),
      kind: entry.kind || 'chat',
      provider: entry.provider || '',
      model: entry.model || '',
      input_tokens: input,
      output_tokens: output,
      total_tokens: num(entry.totalTokens, input + output),
      cost_usd: round10(entry.costUsd),
      duration_ms: num(entry.durationMs),
      created_at: entry.createdAt || new Date().toISOString()
    };
    this.usage.entries.push(rec);
    if (this.usage.entries.length > MAX_LEDGER_ENTRIES) {
      this.usage.entries = this.usage.entries.slice(-MAX_LEDGER_ENTRIES);
    }
    await writeJsonAtomic(USAGE_FILE, this.usage);
    return rec;
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<UsageEntry[]> {
    const { sessionId = null, username = null, limit = 200 } = options;
    let rows = this.usage.entries;
    if (sessionId) rows = rows.filter(r => r.session_id === String(sessionId));
    if (username) rows = rows.filter(r => r.username === String(username));
    return rows.slice(-Math.min(num(limit, 200), 1000)).reverse();
  }

async summary(options: SummaryOptions = {}): Promise<UsageSummary> {
    const { days = 30, username = null } = options;
    let cutoff: number;
    if (days === 1) {
      // "Today" means from midnight today to now
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      cutoff = today.getTime();
    } else {
      cutoff = Date.now() - num(days, 30) * 86400000;
    }
    let rows = this.usage.entries.filter(r => new Date(r.created_at).getTime() >= cutoff);
    if (username) rows = rows.filter(r => r.username === String(username));

    const bucket = (keyFn: (r: UsageEntry) => string): SummaryBucket[] => {
      const map = new Map<string, SummaryBucket>();
      for (const r of rows) {
        const k = keyFn(r);
        if (!map.has(k)) map.set(k, { k, calls: 0, input: 0, output: 0, cost: 0 });
        const b = map.get(k) as SummaryBucket;
        b.calls++; b.input += num(r.input_tokens); b.output += num(r.output_tokens);
        b.cost = round10(b.cost + num(r.cost_usd));
      }
      return [...map.values()];
    };

    const bySession = bucket(r => r.session_id).map(b => ({ ...b, last_at: null }));
    return {
      days: num(days, 30),
      input: rows.reduce((a, r) => a + num(r.input_tokens), 0),
      output: rows.reduce((a, r) => a + num(r.output_tokens), 0),
      total: rows.reduce((a, r) => a + num(r.input_tokens) + num(r.output_tokens), 0),
      cost: round10(rows.reduce((a, r) => a + num(r.cost_usd), 0)),
      calls: rows.length,
      byDay: bucket(r => String(r.created_at).slice(0, 10)).sort((a, b) => a.k.localeCompare(b.k)),
      byModel: bucket(r => r.model || r.provider).sort((a, b) => a.k.localeCompare(b.k)),
      byUser: bucket(r => r.username).sort((a, b) => a.k.localeCompare(b.k)),
      bySession
    };
  }

// -- conversations -------------------------------------------------------
  // The JSON fallback keeps the original one-JSON-file-per-conversation layout
  // so existing data stays readable. Pagination is emulated in memory, which is
  // acceptable because this backend only runs when Postgres is unavailable.

  private file(id: string): string {
    return path.join(config.paths.conversationsDir, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  private async readConv(id: string): Promise<ConversationFile | null> {
    const file = this.file(id);
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as ConversationFile;
    } catch (e) {
      console.warn(`[db] could not read conversation ${id}: ${(e as Error).message}`);
    }
    return null;
  }

  async saveConversationState(
    sessionId: string,
    state: Record<string, unknown> = {},
    meta: Partial<ConversationStateMeta> = {}
  ): Promise<void> {
    const existing = (await this.readConv(sessionId)) || {};
    const merged: ConversationFile = Object.assign(existing, state, {
      mode: meta.mode || existing.mode || 'chat',
      status: meta.status || existing.status || 'active',
      last_control_number: meta.controlNumber !== undefined ? meta.controlNumber : existing.last_control_number,
      uploads: Array.isArray(meta.uploads) ? meta.uploads : (existing.uploads || []),
      user: meta.username ? Object.assign({}, existing.user, { user_name: meta.username }) : existing.user
    });
    await fsp.mkdir(config.paths.conversationsDir, { recursive: true });
    await writeJsonAtomic(this.file(sessionId), merged);
  }

  async appendMessages(sessionId: string, _username: string, messages: StoredMessage[] = []): Promise<number> {
    if (!messages.length) return 0;
    const conv = (await this.readConv(sessionId)) || {};
    if (!Array.isArray(conv.messages)) conv.messages = [];
    let seq = conv.messages.length;
    for (const m of messages) {
      conv.messages.push(Object.assign({ id: ++seq, created_at: new Date().toISOString() }, m));
    }
    await fsp.mkdir(config.paths.conversationsDir, { recursive: true });
    await writeJsonAtomic(this.file(sessionId), conv);
    return messages.length;
  }

  /**
   * Messages and state in one atomic file write.
   *
   * There is no transaction to lean on here, but the two halves can still be
   * merged into a single read-modify-write, which is what makes this the
   * equivalent of the Postgres path: previously saveConversationState and
   * appendMessages each read the file, changed it and wrote it back, so two
   * concurrent saves could drop one another's messages.
   */
  async persistConversation(input: ConversationPersistInput): Promise<ConversationPersistResult> {
    const sessionId = String(input.sessionId);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const existing = (await this.readConv(sessionId)) || {};
    const meta = input.meta || {};

    if (messages.length) {
      if (!Array.isArray(existing.messages)) existing.messages = [];
      let seq = existing.messages.length;
      for (const m of messages) {
        existing.messages.push(Object.assign({ id: ++seq, created_at: new Date().toISOString() }, m));
      }
    }

    Object.assign(existing, input.state || {}, {
      mode: meta.mode || existing.mode || 'chat',
      status: meta.status || existing.status || 'active',
      last_control_number: meta.controlNumber !== undefined ? meta.controlNumber : existing.last_control_number,
      uploads: Array.isArray(meta.uploads) ? meta.uploads : (existing.uploads || []),
      user: meta.username ? Object.assign({}, existing.user, { user_name: meta.username }) : existing.user
    });

    await fsp.mkdir(config.paths.conversationsDir, { recursive: true });
    await writeJsonAtomic(this.file(sessionId), existing);

    const all = Array.isArray(existing.messages) ? existing.messages : [];
    return {
      appended: messages.length,
      lastMessageId: all.length ? num((all[all.length - 1] as { id?: unknown }).id) : 0
    };
  }

  async getConversationState(sessionId: string): Promise<ConversationState | null> {
    const conv = await this.readConv(sessionId);
    if (!conv) return null;
    const { messages: _messages, ...state } = conv;
    return {
      state,
      mode: conv.mode || 'chat',
      status: conv.status || 'active',
      control_number: conv.last_control_number || null,
      uploads: conv.uploads || [],
      username: String((conv.user && conv.user.user_name) || '')
    };
  }

  async listConversations(options: ListConversationsOptions = {}): Promise<StoredConversationRow[]> {
    const { limit = 100 } = options;
    let files: string[] = [];
    try {
      files = (await fsp.readdir(config.paths.conversationsDir))
        .filter(f => f.endsWith('.json'))
        .slice(0, Math.min(num(limit, 100), 500));
    } catch {
      return [];
    }
    const out: StoredConversationRow[] = [];
    for (const f of files) {
      const id = f.replace(/\.json$/, '');
      const conv = await this.readConv(id);
      if (!conv) continue;
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      const stat = await fsp.stat(this.file(id)).catch(() => null);
      // `last_activity` is a legacy field name kept in the index signature, so
      // it has to be narrowed before it can go into new Date().
      const raw = conv.lastActivity ?? conv.last_activity ?? stat?.mtime;
      const mtime = typeof raw === 'number' || typeof raw === 'string' ? raw : null;
      out.push({
        session_id: id,
        username: String((conv.user && conv.user.user_name) || ''),
        mode: conv.mode || 'chat',
        status: conv.status || 'active',
        control_number: conv.last_control_number || null,
        uploads: conv.uploads || [],
        state: conv as Record<string, unknown>,
        message_count: msgs.length,
        created_at: conv.createdAt ? new Date(conv.createdAt).toISOString() : null,
        updated_at: mtime ? new Date(mtime).toISOString() : null,
        last_message_at: mtime ? new Date(mtime).toISOString() : null
      });
    }
    out.sort((a, b) => String(b.last_message_at).localeCompare(String(a.last_message_at)));
    return out;
  }

async pageMessages(sessionId: string, options: PageMessagesOptions = {}): Promise<MessagePage> {
    const { limit = 10, before = null } = options;
    const take = Math.min(Math.max(num(limit, 10), 1), 100);
    const conv = await this.readConv(sessionId);
    const all = conv && Array.isArray(conv.messages) ? conv.messages : [];
    // A cursor that is not a number is no cursor. `?before=null` reaches here as
    // the four-letter string "null" whenever the widget has nothing to page
    // back to, and Number("null") is NaN - which made findIndex() return -1 and
    // the "older" page silently repeat the newest messages instead of walking
    // backwards. Treated as absent, the first page is the correct answer.
    const beforeNum = Number(before);
    const cursor = before !== null && before !== undefined && before !== ''
      && Number.isFinite(beforeNum) ? beforeNum : null;
    const end = cursor === null
      ? all.length
      : all.findIndex(m => num(m.id) >= cursor);
    const slice = all.slice(Math.max(0, end - take), end < 0 ? all.length : end);
    const hasMore = Math.max(0, end - take) > 0;
    // Newest first, to match the Postgres backend's `ORDER BY id DESC`. Both
    // backends must honour the same order or the widget renders the thread
    // differently depending on which one is active. The cursor stays the OLDEST
    // id in the page, which is what `before` is matched against below.
    return {
      messages: slice.slice().reverse() as Array<Record<string, unknown>>,
      has_more: hasMore,
      next_before: hasMore && slice.length ? num(slice[0].id) : null
    };
  }

  async recentMessages(sessionId: string, limit = 20): Promise<StoredMessage[]> {
    const conv = await this.readConv(sessionId);
    const all = conv && Array.isArray(conv.messages) ? conv.messages : [];
    return all.slice(-Math.min(num(limit, 20), 200));
  }

  async deleteConversation(sessionId: string): Promise<void> {
    const file = this.file(sessionId);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {
      console.warn(`[db] could not delete conversation ${sessionId}: ${(e as Error).message}`);
    }
  }

  async pruneOldMessages(): Promise<number> {
    // No-op: the JSON fallback is a short-lived safety net, not the system of
    // record, so it deliberately keeps everything.
    return 0;
  }

  async close(): Promise<void> {
    // Nothing pooled.
  }
}

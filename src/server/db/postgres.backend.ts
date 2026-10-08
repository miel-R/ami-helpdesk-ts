// The Postgres backend. This is the real store; it is used whenever
// DATABASE_URL is set.

import fsp from 'fs/promises';
import path from 'path';
import type { Pool, PoolClient, QueryResult } from 'pg';

const SCHEMA_FILE = path.join(__dirname, '..', '..', '..', 'db', 'schema.sql');
import type {
  StorageBackend, ConversationPersistInput, ConversationPersistResult, StorageHealth,
  UserRecord, UserPatch, UserProfile, UsageEntry, UsageEntryInput,
  ConversationStateMeta, ConversationState, MessagePage,
  SummaryBucket, UsageSummary, ListConversationsOptions, PageMessagesOptions,
  ListMessagesOptions, SummaryOptions, StoredMessage, StoredConversationRow
} from './types.model';
import { REQUIRED_TABLES } from './types.model';
import { num, today, round10, limitValue } from './helpers';

// ---------------------------------------------------------------------------
// Postgres backend
// ---------------------------------------------------------------------------

export class PgBackend implements StorageBackend {
  readonly kind = 'postgres' as const;
  private pool: Pool | null = null;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    // Required lazily so the JSON fallback still works if `pg` is unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Pool: PgPool } = require('pg') as typeof import('pg');

    this.pool = new PgPool({
      connectionString: this.url,
      // Deliberately small. This is a low-traffic chat widget sharing a host
      // with other services, so it must not sit on idle connections.
      max: parseInt(process.env.PGPOOL_MAX ?? '', 10) || 5,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      // A runaway query must not hold locks or CPU indefinitely.
      statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS ?? '', 10) || 10000
    });

    // An idle client erroring out (server restart, network blip) must not take
    // the process down; the pool will replace it on next use.
    this.pool.on('error', (e: Error) => {
      console.error(`[db] idle postgres client error: ${e.message}`);
    });

    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      await this.applySchema(client);
    } finally {
      client.release();
    }
    console.log(`[db] postgres backend active`);
  }

  /** Apply db/schema.sql. Idempotent, and recorded so re-runs are cheap. */
  private async applySchema(client: PoolClient): Promise<void> {
    let sql: string;
    try {
      sql = await fsp.readFile(SCHEMA_FILE, 'utf8');
    } catch (e) {
      throw new Error(`schema file missing at ${SCHEMA_FILE} (${(e as Error).message})`);
    }
    // The gate used to be "does the schema_migrations marker exist". That marker
    // is written by the same DDL that creates the tables, but it survives on its
    // own: a database that kept the marker and lost the tables it was recorded
    // alongside booted clean, logged "schema already present", and then failed
    // every request with `relation "conversations" does not exist`.
    //
    // What actually matters is whether the tables this app reads and writes are
    // there, so that is what gets checked. schema.sql is idempotent
    // (CREATE TABLE IF NOT EXISTS throughout), so re-running it is safe and
    // costs nothing.
    const present = await this.missingTables(client);
    if (!present.length) {
      console.log('[db] schema already present, skipping DDL');
      return;
    }
    if (present.length < REQUIRED_TABLES.length) {
      console.warn(`[db] schema incomplete (missing: ${present.join(', ')}); re-applying DDL`);
    }
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING');
    const stillMissing = await this.missingTables(client);
    if (stillMissing.length) {
      // Better to refuse to start than to serve a process that 500s on every
      // request while reporting itself healthy.
      throw new Error(
        `schema still missing after DDL: ${stillMissing.join(', ')} - check that ${SCHEMA_FILE} is the file this build expects`
      );
    }
    console.log('[db] schema applied (version 1)');
  }

  /** Of the tables this app depends on, the ones this database is missing. */
  private async missingTables(client: PoolClient): Promise<string[]> {
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NULL',
      [REQUIRED_TABLES as unknown as string[]]
    );
    return rows.map(r => r.name);
  }

  /**
   * Real storage round-trip: the required tables exist and can be counted.
   *
   * Counts rather than merely checking existence, because a table can exist and
   * still be unreadable (permissions, a dropped column, a half-finished restore).
   */
  async health(): Promise<StorageHealth> {
    if (!this.pool) return { ok: false, missing: [...REQUIRED_TABLES], error: 'postgres pool not initialised' };
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (e) {
      return { ok: false, missing: [], error: `cannot reach database: ${(e as Error).message}` };
    }
    try {
      const missing = await this.missingTables(client);
      if (missing.length) return { ok: false, missing };
      // Bounded so a huge history cannot make the health endpoint expensive.
      const { rows } = await client.query(
        `SELECT
           (SELECT count(*) FROM conversations) AS conversations,
           (SELECT count(*) FROM messages) AS messages`
      );
      return {
        ok: true,
        missing: [],
        conversations: Number(rows[0]?.conversations ?? 0),
        messages: Number(rows[0]?.messages ?? 0)
      };
    } catch (e) {
      return { ok: false, missing: [], error: (e as Error).message };
    } finally {
      client.release();
    }
  }

  private q(text: string, params: unknown[] = []): Promise<QueryResult> {
    if (!this.pool) throw new Error('postgres pool not initialised');
    return this.pool.query(text, params);
  }

  // -- users ---------------------------------------------------------------

  async ensureUser(profile: UserProfile = { username: '' }): Promise<UserRecord | null> {
    const username = String(profile.username || '').trim();
    if (!username) return null;
    // Keep identity fields fresh from the latest chat request, but never let a
    // client overwrite the admin-controlled fields (role/enabled/limits).
    const { rows } = await this.q(
      `INSERT INTO users (username, display_name, email, department, last_seen)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (username) DO UPDATE
          SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), users.display_name),
              email        = COALESCE(NULLIF(EXCLUDED.email, ''), users.email),
              department   = COALESCE(NULLIF(EXCLUDED.department, ''), users.department),
              last_seen    = now()
       RETURNING *`,
      [username, String(profile.displayName || ''), String(profile.email || ''), String(profile.department || '')]
    );
    return (rows[0] as UserRecord) || null;
  }

  async getUser(username: string): Promise<UserRecord | null> {
    const { rows } = await this.q('SELECT * FROM users WHERE username = $1', [String(username)]);
    return (rows[0] as UserRecord) || null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.q('SELECT * FROM users ORDER BY last_seen DESC NULLS LAST');
    return rows as UserRecord[];
  }

async updateUser(username: string, patch: UserPatch = {}): Promise<UserRecord | null> {
    const sets: string[] = [];
    const params: unknown[] = [String(username)];
    const add = (col: string, val: unknown): void => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (patch.role) add('role', patch.role === 'admin' ? 'admin' : 'user');
    if (patch.enabled !== undefined) add('enabled', !!patch.enabled);
    // undefined = not supplied, so leave the current value untouched. Only an
    // explicit null clears the override and restores inheritance.
    if (patch.requests_per_day !== undefined) add('requests_per_day', limitValue(patch.requests_per_day));
    if (patch.max_upload_bytes !== undefined) add('max_upload_bytes', limitValue(patch.max_upload_bytes));
    if (patch.note !== undefined) add('note', String(patch.note || ''));
    if (!sets.length) return this.getUser(username);

    add('updated_at', new Date().toISOString());
    const { rows } = await this.q(
      `UPDATE users SET ${sets.join(', ')} WHERE username = $1 RETURNING *`,
      params
    );
    return (rows[0] as UserRecord) || null;
  }

  async deleteUser(username: string): Promise<boolean> {
    await this.q('DELETE FROM users WHERE username = $1', [String(username)]);
    return true;
  }

  // -- request quota -------------------------------------------------------

  async getRequestUsage(username: string, day: string = today()): Promise<number> {
    const { rows } = await this.q(
      'SELECT count FROM usage_requests WHERE username = $1 AND day = $2',
      [String(username), day]
    );
    return rows[0] ? num(rows[0].count) : 0;
  }

  async consumeRequest(username: string, day: string = today()): Promise<number> {
    const { rows } = await this.q(
      `INSERT INTO usage_requests (username, day, count) VALUES ($1, $2, 1)
         ON CONFLICT (username, day) DO UPDATE SET count = usage_requests.count + 1
       RETURNING count`,
      [String(username), day]
    );
    return num(rows[0] && rows[0].count);
  }

  // -- token / cost ledger -------------------------------------------------

  async recordMessage(entry: UsageEntryInput = {}): Promise<UsageEntry> {
    const input = num(entry.inputTokens);
    const output = num(entry.outputTokens);
    const { rows } = await this.q(
      `INSERT INTO usage_messages
         (session_id, username, kind, provider, model,
          input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11, now()))
       RETURNING *`,
      [
        String(entry.sessionId || ''), String(entry.username || ''),
        String(entry.kind || 'chat'), String(entry.provider || ''), String(entry.model || ''),
        input, output, num(entry.totalTokens, input + output),
        round10(entry.costUsd), num(entry.durationMs), entry.createdAt || null
      ]
    );
    return rows[0] as UsageEntry;
  }

  async listMessages(options: ListMessagesOptions = {}): Promise<UsageEntry[]> {
    const { sessionId = null, username = null, limit = 200 } = options;
    const params: unknown[] = [Math.min(num(limit, 200), 1000)];
    const where: string[] = [];
    if (sessionId) { params.push(String(sessionId)); where.push(`session_id = $${params.length}`); }
    if (username) { params.push(String(username)); where.push(`username = $${params.length}`); }
    const { rows } = await this.q(
      `SELECT * FROM usage_messages
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC, id DESC LIMIT $1`,
      params
    );
    return rows as UsageEntry[];
  }

async summary(options: SummaryOptions = {}): Promise<UsageSummary> {
    const { days = 30, username = null } = options;
    let params: unknown[];
    let intervalExpr: string;
    let userFilter: string;

    if (days === 1) {
      // "Today" means from midnight today to now
      params = [];
      intervalExpr = "now()::date"; // midnight today (cast date to timestamp = midnight)
      userFilter = username ? 'AND username = $1' : '';
      if (username) params.push(String(username));
    } else {
      params = [num(days, 30)];
      intervalExpr = "now() - ($1 || ' days')::interval";
      userFilter = username ? 'AND username = $2' : '';
      if (username) params.push(String(username));
    }

    const totals = await this.q(
      `SELECT COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cost_usd),0)     AS cost,
              COUNT(*)                      AS calls
         FROM usage_messages
        WHERE created_at >= ${intervalExpr} ${userFilter}`,
      params
    );

    const group = async (expr: string): Promise<SummaryBucket[]> => {
      const { rows } = await this.q(
        `SELECT ${expr} AS k,
                COUNT(*) AS calls,
                COALESCE(SUM(input_tokens),0)  AS input,
                COALESCE(SUM(output_tokens),0) AS output,
                COALESCE(SUM(cost_usd),0)     AS cost
           FROM usage_messages
          WHERE created_at >= ${intervalExpr} ${userFilter}
          GROUP BY 1 ORDER BY 1`,
        params
      );
      return rows as SummaryBucket[];
    };

    const byDay = await group(`to_char(created_at, 'YYYY-MM-DD')`);
    const byModel = await group(`COALESCE(NULLIF(model, ''), provider)`);
    const byUser = await group('username');

    const { rows: bySession } = await this.q(
      `SELECT session_id AS k,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens),0)  AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cost_usd),0)     AS cost,
              MAX(created_at) AS last_at
         FROM usage_messages
        WHERE created_at >= ${intervalExpr} ${userFilter}
        GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT 200`,
      params
    );

    const t = (totals.rows[0] ?? {}) as Record<string, unknown>;
    return {
      days: num(days, 30),
      input: num(t.input), output: num(t.output),
      total: num(t.input) + num(t.output),
      cost: round10(t.cost), calls: num(t.calls),
      byDay, byModel, byUser, bySession: bySession as SummaryBucket[]
    };
  }

  // -- conversations -------------------------------------------------------

  async saveConversationState(
    sessionId: string,
    state: Record<string, unknown> = {},
    meta: Partial<ConversationStateMeta> = {}
  ): Promise<void> {
    await this.q(
      `INSERT INTO conversations
         (session_id, username, mode, status, control_number, uploads, state, message_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (session_id) DO UPDATE
          SET username       = EXCLUDED.username,
              mode           = EXCLUDED.mode,
              status         = EXCLUDED.status,
              control_number = EXCLUDED.control_number,
              uploads        = EXCLUDED.uploads,
              state          = EXCLUDED.state,
              message_count  = EXCLUDED.message_count,
              updated_at     = now(),
              last_message_at= now()`,
      [
        String(sessionId), String(meta.username || ''),
        String(meta.mode || 'chat'), String(meta.status || 'active'),
        meta.controlNumber || null,
        JSON.stringify(Array.isArray(meta.uploads) ? meta.uploads : []),
        JSON.stringify(state || {}),
        num(meta.messageCount)
      ]
    );
  }

  async appendMessages(sessionId: string, username: string, messages: StoredMessage[] = []): Promise<number> {
    if (!messages.length) return 0;
    // One multi-row INSERT: a single round trip instead of one per message.
    const values: string[] = [];
    const params: unknown[] = [String(sessionId), String(username || '')];
    messages.forEach((m, i) => {
      const b = 3 + i * 4;
      values.push(`($1,$2,$${b},$${b + 1},$${b + 2}::jsonb, COALESCE($${b + 3}, now()))`);
      params.push(String(m.role || 'user'), String(m.content || ''));
      params.push(JSON.stringify(m.meta || {}));
      params.push(m.createdAt || null);
    });
    await this.q(
      `INSERT INTO messages (session_id, username, role, content, meta, created_at) VALUES ${values.join(',')}`,
      params
    );
    await this.q(
      `UPDATE conversations
          SET message_count   = message_count + $2,
              last_message_at = now(),
              updated_at      = now()
        WHERE session_id = $1`,
      [String(sessionId), messages.length]
    );
    return messages.length;
  }

  /**
   * Append messages and update the conversation row atomically.
   *
   * Runs on one pooled client inside an explicit transaction, because the two
   * halves write the same row and were previously separate statements that could
   * interleave. `message_count` is set from the authoritative COUNT(*) rather
   * than incremented, so it cannot drift however many times this runs.
   */
  async persistConversation(input: ConversationPersistInput): Promise<ConversationPersistResult> {
    const sessionId = String(input.sessionId);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (!this.pool) throw new Error('postgres pool not initialised');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (messages.length) {
        const values: string[] = [];
        const params: unknown[] = [sessionId, String(input.username || '')];
        messages.forEach((m, i) => {
          const b = 3 + i * 4;
          values.push(`($1,$2,$${b},$${b + 1},$${b + 2}::jsonb, COALESCE($${b + 3}, now()))`);
          params.push(String(m.role || 'user'), String(m.content || ''));
          params.push(JSON.stringify(m.meta || {}));
          params.push(m.createdAt || null);
        });
        await client.query(
          `INSERT INTO messages (session_id, username, role, content, meta, created_at) VALUES ${values.join(',')}`,
          params
        );
      }

      const meta = input.meta || {};
      const { rows: countRows } = await client.query(
        'SELECT count(*)::int AS n, COALESCE(max(id), 0) AS hi FROM messages WHERE session_id = $1',
        [sessionId]
      );
      const messageCount = Number(countRows[0]?.n ?? 0);
      const lastMessageId = Number(countRows[0]?.hi ?? 0);

      await client.query(
        `INSERT INTO conversations
           (session_id, username, mode, status, control_number, uploads, state, message_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
         ON CONFLICT (session_id) DO UPDATE
            SET username       = EXCLUDED.username,
                mode           = EXCLUDED.mode,
                status         = EXCLUDED.status,
                control_number = EXCLUDED.control_number,
                uploads        = EXCLUDED.uploads,
                state          = EXCLUDED.state,
                message_count  = EXCLUDED.message_count,
                updated_at     = now(),
                last_message_at= CASE WHEN $9 > 0 THEN now() ELSE conversations.last_message_at END`,
        [
          sessionId, String(meta.username || ''),
          String(meta.mode || 'chat'), String(meta.status || 'active'),
          meta.controlNumber || null,
          JSON.stringify(Array.isArray(meta.uploads) ? meta.uploads : []),
          JSON.stringify(input.state || {}),
          messageCount,
          messages.length
        ]
      );

      await client.query('COMMIT');
      return { appended: messages.length, lastMessageId };
    } catch (e) {
      // ROLLBACK before releasing: handing a client back to the pool with an
      // open transaction would poison whatever picks it up next.
      try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
      throw e;
    } finally {
      client.release();
    }
  }

  async getConversationState(sessionId: string): Promise<ConversationState | null> {
    const { rows } = await this.q(
      'SELECT state, mode, status, control_number, uploads, username FROM conversations WHERE session_id = $1',
      [String(sessionId)]
    );
    return (rows[0] as ConversationState) || null;
  }

  /**
   * Recent conversations, newest activity first. Read from the database rather
   * than process memory so the admin still lists yesterday's threads after a
   * restart.
   */
  async listConversations(options: ListConversationsOptions = {}): Promise<StoredConversationRow[]> {
    const { limit = 100, username = null } = options;
    const params: unknown[] = [Math.min(num(limit, 100), 500)];
    let filter = '';
    if (username) { params.push(String(username)); filter = 'WHERE c.username = $2'; }
    const { rows } = await this.q(
      `SELECT c.session_id, c.username, c.mode, c.status, c.control_number,
              c.uploads, c.state, c.message_count, c.created_at, c.updated_at, c.last_message_at
         FROM conversations c
         ${filter}
        ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
        LIMIT $1`,
      params
    );
    return rows as StoredConversationRow[];
  }

  /**
   * Newest-first page of messages, keyed on the monotonic id as a cursor.
   * Pass `before` (a message id) to walk further back through a long thread.
   */
  async pageMessages(sessionId: string, options: PageMessagesOptions = {}): Promise<MessagePage> {
    const { limit = 10, before = null } = options;
    const take = Math.min(Math.max(num(limit, 10), 1), 100);
    const params: unknown[] = [String(sessionId), take + 1];
    let cursor = '';
    if (before !== null && before !== undefined && before !== '') {
      params.push(num(before));
      cursor = 'AND id < $3';
    }
    // Fetch ONE MORE ROW than we intend to return, so `has_more` can be decided
    // from the result set instead of a second COUNT query.
    //
    // The LIMIT must be `take + 1`, not `take`. With `LIMIT take` the result can
    // never be longer than `take`, so the `rows.length > take` test below was
    // never true: `has_more` came back false and `next_before` null for EVERY
    // session, however long. The widget therefore never saw a "Load earlier
    // messages" control and scrolling to the top could not load anything - the
    // paging was wired up end to end and simply always answered "that's all".
    //
    // The extra row is trimmed off below and never reaches the caller.
    const { rows } = await this.q(
      `SELECT id, role, content, meta, created_at
            FROM messages
           WHERE session_id = $1 ${cursor}
           ORDER BY id DESC
           LIMIT $2`,
      params
    );
    const hasMore = rows.length > take;
    const page = rows.slice(0, take);
    return {
      messages: page as Array<Record<string, unknown>>,
      has_more: hasMore,
      // Cursor for the next (older) page: the oldest id we just returned.
      next_before: hasMore && page.length ? num((page[page.length - 1] as { id: unknown }).id) : null
    };
  }

  /** Most recent messages, oldest-first. Used to rebuild AI context on restore. */
  async recentMessages(sessionId: string, limit = 20): Promise<StoredMessage[]> {
    const { rows } = await this.q(
      'SELECT role, content FROM messages WHERE session_id = $1 ORDER BY id DESC LIMIT $2',
      [String(sessionId), Math.min(num(limit, 20), 200)]
    );
    return rows.reverse() as StoredMessage[];
  }

  async deleteConversation(sessionId: string): Promise<void> {
    await this.q('DELETE FROM messages WHERE session_id = $1', [String(sessionId)]);
    await this.q('DELETE FROM conversations WHERE session_id = $1', [String(sessionId)]);
  }

  // -- retention -----------------------------------------------------------

  /**
   * Drop message BODIES older than `days`. usage_messages is never pruned: it is
   * the cost/token accounting record and has to survive indefinitely.
   */
  async pruneOldMessages(days = 180): Promise<number> {
    const { rowCount } = await this.q(
      `DELETE FROM messages WHERE created_at < now() - ($1 || ' days')::interval`,
      [num(days, 180)]
    );
    return rowCount ?? 0;
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

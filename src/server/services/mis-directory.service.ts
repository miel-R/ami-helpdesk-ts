// MIS user directory (read-only).
//
// MIS is the identity provider: it already stores each person's real role in
// `scrf_user.user_role`, and this chatbot can read that table directly. That
// makes MIS the single source of truth WITHOUT any change to the MIS PHP code -
// which matters, because the alternative (trusting `AmiChatConfig.userRole`)
// means trusting a value the browser can edit, so anyone can type themselves an
// admin role with curl.
//
// The lookup is server-to-server: the browser is never trusted and never
// involved. If MIS is unreachable we return null and the caller falls back to
// the chatbot's own database, so an MIS outage degrades rather than breaks.
//
// Only SELECTs are issued, against one table, one column.

import mysql from 'mysql2/promise';
import { config } from '../config/config.service';
import { normalizeRole } from '../services/identity.service';
import type { Role } from '../models/types.model';

/** What a MIS lookup returns: the mapped role, plus MIS's own raw string. */
export interface MisRoleRecord {
  role: Role;
  raw: string;
}

/**
 * Short cache. /api/chat runs on every message but the role rarely changes, and
 * this stops a busy user generating a MIS query per message. 60s is well inside
 * the "changes take effect on next login" window.
 */
const CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  role: Role | null;
  raw: string | null;
  expires: number;
}

let pool: mysql.Pool | null = null;
let poolBroken = false;
const cache = new Map<string, CacheEntry>();

export function enabled(): boolean {
  const d = config.misDb;
  return !!(d && d.host && d.database && d.user);
}

async function getPool(): Promise<mysql.Pool | null> {
  if (!enabled() || poolBroken) return pool;
  if (pool) return pool;

  const d = config.misDb;
  try {
    pool = mysql.createPool({
      host: d.host,
      port: d.port || 3306,
      user: d.user,
      password: d.password || '',
      database: d.database,
      waitForConnections: true,
      connectionLimit: 3,
      connectTimeout: 5000,
      // Read-only session: even a bug cannot write to MIS.
      multipleStatements: false
    });
    return pool;
  } catch (e) {
    poolBroken = true;
    console.warn(`[mis] pool unavailable: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Look up one person's MIS role.
 *
 * @param login MIS login id, e.g. "remiel.baking"
 * @returns the mapped role, or null when MIS is not configured, unreachable, or
 *          has no such user. Callers must treat null as "unknown", not "user".
 */
export async function lookupRole(login: string): Promise<MisRoleRecord | null> {
  const key = String(login || '').trim();
  if (!key || !enabled()) return null;

  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return hit.role ? { role: hit.role, raw: hit.raw ?? '' } : null;
  }

  const p = await getPool();
  if (!p) return null;

  try {
    // Same query MIS itself runs (scrf.mysql.pdo.php):
    //   SELECT user_role FROM scrf_user WHERE user_name = ?
    const [rows] = await p.query(
      'SELECT user_role FROM scrf_user WHERE user_name = ? LIMIT 1',
      [key]
    );

    const list = rows as Array<{ user_role?: string }>;
    if (!list || list.length === 0) {
      cache.set(key, { role: null, raw: null, expires: Date.now() + CACHE_TTL_MS });
      return null;
    }

    const raw = String(list[0].user_role ?? '');
    // Same MIS -> chatbot mapping as the signed path, so both routes agree: only
    // "Admin" means admin; "Approver" and "User" are normal users.
    const role = normalizeRole(raw);

    cache.set(key, { role, raw, expires: Date.now() + CACHE_TTL_MS });
    return { role, raw };
  } catch (e) {
    // Fail soft. A MIS outage must not take the chatbot down, and must not
    // silently grant access either.
    const err = e as { code?: string; message: string };
    console.warn(`[mis] role lookup failed for ${key}: ${err.code || err.message}`);
    cache.delete(key);
    return null;
  }
}

/**
 * Batch variant of lookupRole(), for the analytics dashboard's Users tab.
 *
 * The dashboard needs every user's helpdesk role at once, not one chat turn's
 * worth at a time. Issuing lookupRole() per row would mean N queries per refresh,
 * and the dashboard re-renders on a 15s timer, so that is a real load rather than
 * a theoretical one.
 *
 * Returns MIS's OWN raw role string ("Admin" / "Approver" / "User") keyed by
 * login, because the dashboard reports the helpdesk role, not the chatbot's
 * admin/user collapse of it - see analytics-tables.service.ts.
 *
 * Fails soft to a partial map: logins MIS did not answer for are simply absent,
 * and the caller falls back to the chatbot's stored role for those. An empty map
 * means "MIS could not tell us", which is different from "everyone is a user" and
 * must not be rendered as though every row had the same role.
 */
export async function lookupRoles(logins: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!enabled() || !logins.length) return out;

  const wanted = Array.from(new Set(logins.map(l => String(l || '').trim()).filter(Boolean)));
  if (!wanted.length) return out;

  // Reuse the same 60s cache lookupRole() fills, so a dashboard refresh that
  // changes nothing costs zero MIS queries.
  const misses: string[] = [];
  const now = Date.now();
  for (const login of wanted) {
    const hit = cache.get(login);
    if (hit && hit.expires > now) {
      if (hit.raw) out.set(login, hit.raw);
    } else {
      misses.push(login);
    }
  }
  if (!misses.length) return out;

  const p = await getPool();
  if (!p) return out;

  // Chunked because an unbounded IN (...) list is one very long statement, and
  // the Users tab can hold every login that has ever chatted.
  const CHUNK = 200;
  for (let i = 0; i < misses.length; i += CHUNK) {
    const slice = misses.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(', ');
    try {
      const [rows] = await p.query(
        `SELECT user_name, user_role FROM scrf_user WHERE user_name IN (${placeholders})`,
        slice
      );
      const list = (rows as Array<{ user_name?: string; user_role?: string }>) || [];
      const found = new Set<string>();
      for (const row of list) {
        const login = String(row.user_name ?? '').trim();
        if (!login) continue;
        found.add(login);
        const raw = String(row.user_role ?? '');
        out.set(login, raw);
        // Cache under the same entry shape lookupRole() writes, so the two
        // functions never disagree about one person's role.
        cache.set(login, { role: normalizeRole(raw), raw, expires: Date.now() + CACHE_TTL_MS });
      }
      // Remember the misses too, so a person who simply is not in MIS is not
      // re-queried on every refresh for the next 60 seconds.
      for (const login of slice) {
        if (found.has(login)) continue;
        cache.set(login, { role: null, raw: null, expires: Date.now() + CACHE_TTL_MS });
      }
    } catch (e) {
      const err = e as { code?: string; message: string };
      console.warn(`[mis] batch role lookup failed (${slice.length} logins): ${err.code || err.message}`);
      return out; // partial results beat none; callers fall back per-login
    }
  }

  return out;
}

/** Drop a cached entry, e.g. after a role change is known. */
export function invalidate(login: string): void {
  cache.delete(String(login || '').trim());
}

export async function close(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    pool = null;
  }
}

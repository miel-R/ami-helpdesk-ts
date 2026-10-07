// The MIS connection and the caches every catalogue query shares.
//
// Split out from the queries themselves because all four catalogue groups - the
// System Request list, the Tech Support list, IT assets and the directory - read
// through the same pool and the same caches, and invalidating a list therefore
// has to be able to reach all of them.
//
// Two rules hold here and are relied on by every caller:
//
//   - A query NEVER throws. MIS being unreachable means the user gets an open
//     question instead of a list, not a 500.
//   - A failure is cached for 30s, not five minutes, so a blip does not disable
//     a list for the rest of the session.

import mysql from 'mysql2/promise';
import { config } from '../../config/config.service';

export type Row = Record<string, unknown>;

/** An IT asset item and how many MIS has on hand. */
export interface ItAssetItem {
  value: string;
  onhand: number | null;
}

/** Lists change when MIS is reconfigured, but not so often that a stale list for
 *  a whole working day is acceptable. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Short retry after a failure, so a blip does not disable a list for 5 minutes. */
const FAILURE_TTL_MS = 30 * 1000;

interface CacheEntry {
  value: string[];
  expires: number;
}

export interface ItemCacheEntry {
  value: ItAssetItem[];
  expires: number;
}

export interface IdCacheEntry {
  value: Record<string, number>;
  expires: number;
}

/** Options with ids, keyed by the query that produced them. */
export const optionCache = new Map<string, { value: CatalogOption[]; expires: number }>();

let pool: mysql.Pool | null = null;
export const cache = new Map<string, CacheEntry>();
export const itemCache = new Map<string, ItemCacheEntry>();
export const idCache = new Map<string, IdCacheEntry>();
export const rowCache = new Map<string, { value: unknown[]; expires: number }>();

export interface CatalogOption {
  id: number;
  name: string;
  /**
   * Always present, and always a string: '' means "not grouped".
   *
   * Optional would be tidier, but every caller has to render it either way, and
   * `group ?? ''` scattered through the widget is exactly the kind of thing that
   * turns a missing group into an empty dropdown.
   */
  group: string;
}

export function enabled(): boolean {
  const d = config.misDb;
  return !!(d && d.host && d.database && d.user);
}

async function getPool(): Promise<mysql.Pool | null> {
  if (!enabled() || pool) return pool;
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
  } catch (e) {
    console.warn(`[catalog] pool unavailable: ${(e as Error).message}`);
    pool = null;
  }
  return pool;
}

export function strings(rows: Row[], field: string): string[] {
  return rows.map(r => String(r[field] ?? '').trim()).filter(Boolean);
}

/** Run a SELECT, cached, and never throw. Returns [] on any problem. */
export async function queryCached(
  key: string,
  sql: string,
  params: unknown[],
  map: (rows: Row[]) => string[]
): Promise<string[]> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const p = await getPool();
  if (!p) return [];

  try {
    const [rows] = await p.query(sql, params);
    const value = map(rows as Row[]);
    cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (e) {
    // A renamed column must not break intake; the caller falls back to asking the
    // question without options.
    const err = e as { code?: string; message: string };
    console.warn(`[catalog] ${key} failed: ${err.code || err.message}`);
    cache.set(key, { value: [], expires: Date.now() + FAILURE_TTL_MS });
    return [];
  }
}

/**
 * Rows, cached, and mapped into whatever shape the caller needs.
 *
 * Generic so the IT asset list can be cached as `ItAssetItem[]` rather than being
 * squeezed into the `Row` shape and unpacked again at every call site.
 */
export async function queryRows<T>(
  key: string,
  sql: string,
  params: unknown[],
  map: (rows: Row[]) => T[]
): Promise<T[]> {
  const hit = rowCache.get(key) as { value: T[]; expires: number } | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;

  const p = await getPool();
  if (!p) return [];

  try {
    const [rows] = await p.query(sql, params);
    const value = map(rows as Row[]);
    rowCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (e) {
    const err = e as { code?: string; message: string };
    console.warn(`[catalog] ${key} failed: ${err.code || err.message}`);
    rowCache.set(key, { value: [] as T[], expires: Date.now() + FAILURE_TTL_MS });
    return [];
  }
}

/**
 * A name -> numeric id map, cached, from MIS.
 *
 * Read from MIS rather than hardcoded so it can never go stale when MIS adds,
 * renames or reorders a category. Returns {} when MIS is unreachable, which
 * leaves the id fields blank rather than wrong - a blank id is visible, a guessed
 * one files the ticket against the wrong category.
 */
export async function queryIdMap(
  key: string,
  sql: string,
  params: unknown[],
  nameField: string,
  idField: string
): Promise<Record<string, number>> {
  const hit = idCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const p = await getPool();
  if (!p) return {};

  try {
    const [rows] = await p.query(sql, params);
    const map: Record<string, number> = {};
    for (const r of rows as Row[]) {
      const name = String(r[nameField] ?? '').trim();
      const id = Number(r[idField]);
      if (name && Number.isFinite(id)) map[name] = id;
    }
    idCache.set(key, { value: map, expires: Date.now() + CACHE_TTL_MS });
    return map;
  } catch (e) {
    const err = e as { code?: string; message: string };
    console.warn(`[catalog] ${key} failed: ${err.code || err.message}`);
    idCache.set(key, { value: {}, expires: Date.now() + FAILURE_TTL_MS });
    return {};
  }
}

/**
 * Rows carrying objects, so they get their own typed cache.
 *
 * Same contract as queryCached - never throws, fails soft for 30s - but the cached
 * value is an option list rather than strings, because that is what the dropdowns
 * need: an id, a label and, for System Request, a group.
 */
export async function queryOptionsCached(
  key: string,
  sql: string,
  params: unknown[],
  map: (rows: Row[]) => CatalogOption[]
): Promise<CatalogOption[]> {
  const hit = optionCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const p = await getPool();
  if (!p) return [];

  try {
    const [rows] = await p.query(sql, params);
    const value = map(rows as Row[]);
    optionCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (e) {
    const err = e as { code?: string; message: string };
    console.warn(`[catalog] ${key} failed: ${err.code || err.message}`);
    optionCache.set(key, { value: [], expires: Date.now() + FAILURE_TTL_MS });
    return [];
  }
}

export function invalidate(key?: string): void {
  if (key) {
    cache.delete(key);
    itemCache.delete(key);
    idCache.delete(key);
    for (const k of [...rowCache.keys()]) if (k.startsWith(key)) rowCache.delete(k);
  } else {
    cache.clear();
    itemCache.clear();
    idCache.clear();
    rowCache.clear();
  }
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
  cache.clear();
  itemCache.clear();
}
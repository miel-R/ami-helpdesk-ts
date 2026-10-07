// Per-user limits and quotas.
//
// Limits resolve in this order:
//   1. the per-user override stored in the db (admin controlled)
//   2. the server-wide default from config / environment
// A NULL override means "inherit the default", so changing the global
// REQUESTS_PER_DAY still affects every user who was never customised.

import { config } from '../config/config.service';
import { db } from '../db/storage.service';
import type { SessionUser } from '../models/types.model';

/** The stored shape of a user row, as limits needs it. */
export interface LimitUser {
  role?: string;
  requests_per_day?: number | null;
  max_upload_bytes?: number | null;
  enabled?: boolean;
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
  code: string | null;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  /** True when storage failed and we failed OPEN rather than block the chat. */
  degraded?: boolean;
  user?: LimitUser | null;
}

/** Effective daily request cap for a user. Admins are exempt. */
export function effectiveRequestsPerDay(user: LimitUser | null | undefined): number {
  if (user && user.role === 'admin') return Infinity;
  if (user && user.requests_per_day !== null && user.requests_per_day !== undefined) {
    return Number(user.requests_per_day);
  }
  return config.rateLimit.requestsPerDay;
}

/** Effective max upload size in bytes. */
export function effectiveMaxUploadBytes(user: LimitUser | null | undefined): number {
  if (user && user.max_upload_bytes !== null && user.max_upload_bytes !== undefined) {
    return Number(user.max_upload_bytes);
  }
  return config.security.maxFileSize;
}

/**
 * Check whether a user may proceed, WITHOUT consuming quota.
 *
 * Fails OPEN when storage is unavailable: a reporting outage must not stop
 * people getting help. That is a deliberate trade, and `degraded` is returned so
 * the caller can tell the difference between "allowed" and "we could not tell".
 */
export async function checkAccess(username: string): Promise<AccessDecision> {
  let user: LimitUser | null = null;
  try {
    user = (await db().getUser(username)) as LimitUser | null;
  } catch (e) {
    console.warn(`[limits] user lookup failed for ${username}: ${(e as Error).message}`);
    return {
      allowed: true, reason: '', code: null,
      limit: null, used: null, remaining: null, degraded: true
    };
  }

  if (user && user.enabled === false) {
    return {
      allowed: false,
      code: 'disabled',
      reason: 'Your access to the helpdesk assistant has been disabled. Please contact MIS.',
      limit: null, used: null, remaining: 0
    };
  }

  if (user && user.role === 'admin') {
    return {
      allowed: true, reason: '', code: null,
      limit: Infinity, used: null, remaining: Infinity, user
    };
  }

  const limit = effectiveRequestsPerDay(user);
  let used = 0;
  try {
    used = await db().getRequestUsage(username);
  } catch (e) {
    console.warn(`[limits] usage lookup failed for ${username}: ${(e as Error).message}`);
    return { allowed: true, reason: '', code: null, limit, used: null, remaining: null, degraded: true, user };
  }

  if (used >= limit) {
    return {
      allowed: false,
      code: 'rate_limited',
      reason: `You've reached your daily limit of ${limit} request${limit === 1 ? '' : 's'}. Please try again tomorrow or contact MIS for a higher limit.`,
      limit,
      used,
      remaining: 0,
      user
    };
  }

  return { allowed: true, reason: '', code: null, limit, used, remaining: Math.max(0, limit - used), user };
}

/** Consume one request against the user's daily quota. */
export async function consume(username: string): Promise<unknown> {
  try {
    return await db().consumeRequest(username);
  } catch (e) {
    console.warn(`[limits] could not consume request for ${username}: ${(e as Error).message}`);
    return null;
  }
}

/** Multer fileSize limit for this user, in bytes. */
export async function uploadLimitFor(username: string): Promise<number> {
  let user: LimitUser | null = null;
  try {
    user = (await db().getUser(username)) as LimitUser | null;
  } catch {
    return config.security.maxFileSize;
  }
  return effectiveMaxUploadBytes(user);
}

// Re-exported so callers do not need a second import for the user shape.
export type { SessionUser };

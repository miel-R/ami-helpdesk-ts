import crypto from 'crypto';
import type { IdentityClaims, ResolvedIdentity, Role, RoleSource } from '../models/types.model';

const ROLE_ADMIN: Role = 'admin';
const ROLE_USER: Role = 'user';

/**
 * Map a MIS role onto a chatbot role.
 *
 * MIS has three roles and only ONE of them means anything to the chatbot:
 *
 *   MIS "Admin"    -> chatbot "admin" - dashboard, $diagnose, $test-webhook,
 *                                      $disable/$enable
 *   MIS "Approver" -> chatbot "user"  - normal chat, no admin access
 *   MIS "User"     -> chatbot "user"  - normal chat, no admin access
 *
 * Approver deliberately gets nothing extra. It is a MIS workflow permission
 * (signing off tickets/assets), a different concern from operating the chatbot,
 * and granting admin on that basis would hand $disable and the dashboard to
 * anyone who can approve a request.
 *
 * Anything unrecognised falls through to "user": an unexpected role string can
 * never be a way to gain access.
 */
export const MIS_ROLE_MAP: Readonly<Record<string, Role>> = Object.freeze({
  admin: ROLE_ADMIN,
  approver: ROLE_USER,
  user: ROLE_USER
});

/** Short-lived on purpose: a tab left open all day should not keep asserting a
 *  role that may have changed in MIS hours ago. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/** Normalise anything MIS might store into 'admin' or 'user'. */
export function normalizeRole(role: unknown): Role {
  const key = String(role ?? '').trim().toLowerCase();
  return MIS_ROLE_MAP[key] ?? ROLE_USER;
}

/** The claims a token can carry. */
export interface IdentityInput {
  login: string;
  name?: string;
  dept?: string;
  role?: string;
  exp?: number;
}

/**
 * Build a token. The PHP side produces these in production; this exists so the
 * Node tests can mint them and so the format lives in one place.
 */
export function signIdentity(claims: IdentityInput, secret: string): string {
  if (!secret) throw new Error('IDENTITY_SECRET is not configured');
  const payload = {
    login: String(claims.login ?? '').trim(),
    name: String(claims.name ?? '').trim(),
    dept: String(claims.dept ?? '').trim(),
    role: normalizeRole(claims.role),
    exp: Number(claims.exp) || Date.now() + DEFAULT_TTL_MS
  };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify a token and return its claims, or null if it cannot be trusted.
 *
 * Fails closed on every path: bad shape, bad signature, expired, or no secret
 * configured. Never throws, because this sits directly on the chat route.
 */
export function verifyIdentity(token: unknown, secret: string): IdentityClaims | null {
  if (!secret || !token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const body = parts[0];
  const providedSig = parts[1];

  // Constant-time compare, so the signature cannot be recovered byte by byte by
  // timing the comparison.
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = fromB64url(providedSig);
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let claims: Partial<IdentityClaims> & { exp?: unknown };
  try {
    claims = JSON.parse(fromB64url(body).toString('utf8')) as typeof claims;
  } catch {
    return null;
}

  if (!claims || typeof claims !== 'object') return null;

  const login = String(claims.login ?? '').trim();
  if (!login) return null;

  const exp = Number(claims.exp) || 0;
  if (!exp || exp < Date.now()) return null;

  return {
    login,
    name: String(claims.name ?? '').trim(),
    dept: String(claims.dept ?? '').trim(),
    role: normalizeRole(claims.role),
    exp
  };
}
export interface ResolveRoleInput {
  /** Login being claimed. */
  loginId: string;
  /** Role from the users row. */
  dbRole: string;
  /** Signed assertion, if any. */
  identityToken?: unknown;
  /** IDENTITY_SECRET. */
  secret: string;
  /** Raw ADMIN_USERS string. */
  allowlist?: string;
  /** Role from the MIS user directory, or null. */
  directoryRole?: Role | null;
}

/**
 * Resolve the authoritative chat role for one request.
 *
 * Shared by /api/chat and /api/session so there is exactly ONE implementation of
 * the authorization rules; duplicating it is how two routes drift apart and one
 * of them quietly becomes forgeable.
 *
 * Priority:
 *   1. a valid MIS-signed token, which must be for the same login being claimed
 *   2. the MIS user directory (read server-to-server)
 *   3. the stored database role, then the ADMIN_USERS bootstrap allowlist
 *
 * The raw `user_role` request field is never consulted.
 */
export function resolveRole({
  loginId,
  dbRole,
  identityToken,
  secret,
  allowlist,
  directoryRole
}: ResolveRoleInput): ResolvedIdentity {
  const login = String(loginId ?? '').trim();
  const list = String(allowlist ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const dbIsAdmin = String(dbRole ?? '') === 'admin';
  const allowlistHit = list.includes(login.toLowerCase());

  let isAdmin = dbIsAdmin || allowlistHit;
  let source: RoleSource = dbIsAdmin ? 'database' : allowlistHit ? 'allowlist' : 'database';

  const mis = verifyIdentity(identityToken, secret);
  const loginMatched = !!mis && !!login && mis.login.toLowerCase() === login.toLowerCase();

  if (loginMatched && mis.role === 'admin') {
    // MIS says admin. Grant, and never revoke below what the database grants, so
    // a signed-in admin is not locked out by a stale dashboard row.
    isAdmin = true;
    source = 'mis';
  }

  // The MIS directory only ever ADDS admin, never removes it, so an unreachable
  // MIS cannot revoke access someone genuinely has.
  if (!isAdmin && directoryRole === ROLE_ADMIN) {
    isAdmin = true;
    source = 'mis-directory';
  }

  return { role: isAdmin ? ROLE_ADMIN : ROLE_USER, source, isAdmin, mis, loginMatched };
}

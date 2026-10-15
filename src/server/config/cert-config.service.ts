// Where the certificate-trust page sends the user when they are done.
//
// Lives in Postgres rather than `.env` for the reason ticket-modals.service.ts
// gives: this is changed by an admin, from the dashboard, while the chatbot is
// running, and an env var would mean a restart for every edit. Cached on the same
// 30-second clock, and the dashboard calls invalidateCertConfig() on save so an
// admin does not wait at all.
//
// Three layers, in order:
//
//   1. the database override, if an admin has ever saved one
//   2. AMI_CERT_BACK_URL from the environment, the deployment default
//   3. the compiled-in fallback, so a fresh checkout still produces a usable link
//
// The env default sits *below* the database rather than replacing it, which is the
// opposite of the behaviour an env var gives you for free: an operator changing
// `.env` cannot silently undo an admin's dashboard change.

import { db } from '../db/storage.service';
import { CERT_BACK_URL_KEY } from '../db/types.model';

const CACHE_TTL_MS = 30_000;

/** Used when neither the database nor AMI_CERT_BACK_URL says anything. */
export const DEFAULT_HELPDESK_URL = 'https://192.1.5.21/mis_helpdesk/index.php';

let cache: { at: number; value: string } | null = null;
let inflight: Promise<string> | null = null;

/**
 * A stored address is only usable if it parses as an absolute http(s) URL.
 *
 * The value reaches a browser as an href, so a bad one is not a cosmetic problem.
 * Rejecting it here keeps the validation in one place rather than trusting every
 * writer - the dashboard validates on save, but a row can also arrive from a
 * migration, a manual psql edit, or a restore of another environment's data.
 */
function usableUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** The deployment default from the environment, if it is set to something valid. */
function envDefault(): string {
  return usableUrl(process.env.AMI_CERT_BACK_URL) ?? DEFAULT_HELPDESK_URL;
}

/**
 * The address the confirmation page links to, already validated.
 *
 * A read failure returns the env default rather than throwing. This page is the
 * thing a user sees when something is already broken, so it must degrade to a
 * working link - losing the override is annoying, but a thrown error here would
 * leave the page with no link at all, which is the failure we are trying to fix.
 */
export async function getCertBackUrl(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  // One query per window even if several page views arrive at once.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const stored = usableUrl(await db().getCertBackUrl());
      const value = stored ?? envDefault();
      cache = { at: Date.now(), value };
      return value;
    } catch (e) {
      console.warn(
        `[cert-config] read failed, using the env default: ${(e as Error).message}`
      );
      return envDefault();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Called after a dashboard save so the change takes effect immediately. */
export function invalidateCertConfig(): void {
  cache = null;
}

/**
 * Persist an admin's override.
 *
 * Validates before writing rather than trusting the caller, because the row is
 * served straight into an href on a page whose whole job is to get the user back
 * to their Helpdesk. An unparseable address is rejected outright instead of being
 * stored and then filtered out on read, so the dashboard can tell the admin their
 * entry was wrong.
 */
export async function saveCertBackUrl(value: string): Promise<string> {
  const url = usableUrl(value);
  if (!url) {
    throw new Error('helpdesk_url must be an absolute http:// or https:// address');
  }
  const saved = usableUrl(await db().setCertBackUrl(url)) ?? url;
  cache = { at: Date.now(), value: saved };
  return saved;
}

/** Exported for the boot-time warm-up and for tests. */
export const CERT_BACK_URL_ROW_KEY = CERT_BACK_URL_KEY;

/**
 * Prefilled on first boot so the Settings tab has something to show before anyone
 * has saved anything. Failures are ignored: the read path already degrades.
 */
export async function warmCertConfig(): Promise<void> {
  try { await getCertBackUrl(); } catch { /* read path already degrades */ }
}
// Which ticket types the chatbot fills in itself, and where the rest are sent.
//
// The switches live in Postgres rather than in .env because they are changed by
// an admin, from the dashboard, while the chatbot is running. An env var would
// mean a restart for every tweak, and people would stop making tweaks.
//
// Cached for 30 seconds so a burst of chat turns does not re-query on each one.
// Short enough that flipping a switch in the dashboard is visibly effective
// within half a minute, long enough that the query is noise. The dashboard calls
// `invalidateTicketModals()` on save, so an admin does not wait at all.

import { db } from '../db/storage.service';
import { TICKET_TYPES, type TicketModalConfig } from '../db/types.model';

/** What the widget and the chat pipeline actually need. */
export interface TicketModalSetting {
  enabled: boolean;
  external_url: string | null;
}

export type TicketModalSettings = Record<string, TicketModalSetting>;

const CACHE_TTL_MS = 30_000;

let cache: { at: number; value: TicketModalSettings } | null = null;
let linksOnlyCache: { at: number; value: boolean } | null = null;
let inflight: Promise<TicketModalSettings> | null = null;

/** Every type enabled, which is the behaviour from before the feature existed. */
function defaults(): TicketModalSettings {
  const out: TicketModalSettings = {};
  for (const t of TICKET_TYPES) out[t] = { enabled: true, external_url: null };
  return out;
}

/**
 * A database failure degrades to "everything enabled" rather than throwing.
 *
 * The alternative is a ticket handover that fails with a 500 because a config
 * table is briefly unreachable, which would make an infrastructure blip look
 * like the chatbot is broken. A config read is not worth failing a user over.
 */
function fromRows(rows: TicketModalConfig[]): TicketModalSettings {
  const out = defaults();
  for (const r of rows || []) {
    if (!r || !(r.ticket_type in out)) continue;
    out[r.ticket_type] = {
      enabled: r.enabled !== false,
      external_url: r.external_url ?? null
    };
  }
  return out;
}

export async function getTicketModals(): Promise<TicketModalSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  // One query per window even if several turns arrive at once.
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const value = fromRows(await db().listTicketModalConfig());
      cache = { at: Date.now(), value };
      return value;
    } catch (e) {
      console.warn(`[ticket-modals] read failed, treating all types as enabled: ${(e as Error).message}`);
      return defaults();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** One type's setting, or the safe default when it is not in the table. */
export async function getTicketModalSetting(type: string): Promise<TicketModalSetting> {
  const all = await getTicketModals();
  return all[type] ?? { enabled: true, external_url: null };
}

/** Called after a dashboard save so the change takes effect immediately. */
export function invalidateTicketModals(): void {
  cache = null;
  linksOnlyCache = null;
}

/**
 * The master switch.
 *
 * When on, NO ticket type opens a form and every type is handed to the user as a
 * link instead. It overrides the per-type switches entirely rather than combining
 * with them, because "show me links for everything" has no per-type reading: a
 * half-links mode where one type still opens a form is just the confusing case.
 *
 * Cached on the same 30s clock as the per-type settings so the two can never
 * disagree with each other for long - a stale "links only" reading would suppress
 * a form the admin had just re-enabled.
 *
 * A read failure returns false. That direction is the safe one: it restores the
 * chatbot's original behaviour rather than silently taking ticket creation away.
 */
export async function getLinksOnlyMode(): Promise<boolean> {
  if (linksOnlyCache && Date.now() - linksOnlyCache.at < CACHE_TTL_MS) return linksOnlyCache.value;
  try {
    const value = await db().getLinksOnlyMode();
    linksOnlyCache = { at: Date.now(), value: value === true };
    return linksOnlyCache.value;
  } catch (e) {
    console.warn(`[ticket-modals] links-only read failed, treating as off: ${(e as Error).message}`);
    return false;
  }
}

export async function saveLinksOnlyMode(on: boolean): Promise<boolean> {
  const saved = await db().setLinksOnlyMode(on);
  invalidateTicketModals();
  linksOnlyCache = { at: Date.now(), value: saved === true };
  return linksOnlyCache.value;
}

export async function saveTicketModalSetting(
  type: string, enabled: boolean, externalUrl: string | null
): Promise<TicketModalConfig> {
  const saved = await db().updateTicketModalConfig(type, enabled, externalUrl);
  invalidateTicketModals();
  return saved;
}

/**
 * Prefilled on first boot so the admin tab has something to show before anyone
 * has saved anything. Failures are ignored: the read path already degrades.
 */
export async function warmTicketModals(): Promise<void> {
  try { await getTicketModals(); } catch { /* read path already degrades */ }
  try { await getLinksOnlyMode(); } catch { /* read path already degrades */ }
}
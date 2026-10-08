// Bootstrap: initialise storage, start the background work, listen, and shut
// down cleanly.
//
// Everything here is about the process lifecycle. Keeping it out of app.ts means
// the wiring can be read in one screen, and keeping it out of main.ts is what
// let the chat handler become a controller instead of the whole server.

import fs from 'fs';
import { app } from './app';
import { config } from './config/config.service';
import { init as initDb, db } from './db/storage.service';
import conversationManager from './services/session.service';
import { loadCostRates } from './config/cost-rates.service';
import { expireIfIdle } from './services/session-lifecycle.service';

const MESSAGE_RETENTION_DAYS = parseInt(process.env.MESSAGE_RETENTION_DAYS ?? '', 10) || 180;
const RETENTION_SWEEP_MS = 24 * 60 * 60 * 1000;
// Well inside the session timeout so a closed tab is marked ended on schedule
// rather than whenever the user next happens to open the widget.
const IDLE_SWEEP_MS = Math.max(30_000, Math.floor(config.conversation.sessionTimeout / 4));

const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;

/** Drop message rows past the retention window. */
function scheduleRetention(): void {
  const sweep = async (): Promise<void> => {
    try {
      const removed = await db().pruneOldMessages(MESSAGE_RETENTION_DAYS);
      if (removed) console.log(`[retention] pruned ${removed} message(s) older than ${MESSAGE_RETENTION_DAYS} days`);
    } catch (e) {
      console.warn(`[retention] sweep failed: ${(e as Error).message}`);
    }
  };
  const t = setInterval(() => void sweep(), RETENTION_SWEEP_MS);
  if (t.unref) t.unref();
  setTimeout(() => void sweep(), 15000).unref?.();
}

/**
 * Close idle sessions on a timer.
 *
 * Expiry used to be checked only when a request arrived, so a session could sit
 * "active" indefinitely: the user who closed the tab never triggered it, and an
 * open-but-idle widget only noticed on its next message. This walks the live
 * conversations on a fixed interval so `status` and the stored `last_seen`
 * reflect reality without anyone having to ask.
 */
function scheduleIdleExpiry(): void {
  const sweep = (): void => {
    try {
      for (const [sessionId, conv] of conversationManager.getAllConversations()) {
        const bag = conv as unknown as { last_seen?: number; pending_goodbye?: string | null; form_active?: boolean };
        if (bag.pending_goodbye) continue;
        if (bag.form_active) continue;
        const idleSince = Number(bag.last_seen ?? conv.lastActivity ?? 0);
        if (!idleSince) continue;
        if (Date.now() - idleSince <= config.conversation.sessionTimeout) continue;
        if (!conv.messages.length && !Object.keys(conv.collected_fields || {}).length) continue;
        if (expireIfIdle(sessionId, conv)) {
          // Queued rather than awaited: the sweep walks many sessions and must
          // not block on each one. flushWrites() covers it on shutdown.
          void conversationManager.saveConversation(sessionId);
        }
      }
      // Nothing else removed entries from the map, so this sweep was also the only
      // place that could. Without it a long-running container accumulated every
      // session it had ever seen - each holding its transcript and uploads - and
      // the loop above got slower with lifetime traffic rather than with live
      // load. Runs last so the eviction is judged on post-expiry state, and skips
      // anything with a write still queued.
      conversationManager.evictIdle();
    } catch (e) {
      console.warn(`[session] idle sweep failed: ${(e as Error).message}`);
    }
  };
  const t = setInterval(sweep, IDLE_SWEEP_MS);
  if (t.unref) t.unref();
}

/**
 * Drain conversation writes before the process exits.
 *
 * Without this, every deploy silently discarded whatever write was in flight -
 * typically the last exchange of each open conversation, and the `greeted` flag
 * that stops the greeting repeating. `docker compose up --force-recreate` sends
 * SIGTERM and then waits, so this is the difference between a restart being
 * invisible and a restart costing users their history.
 *
 * Two things worth knowing about the semantics here:
 *   - `conversationManager.saveConversation` is idempotent. Calling it again for
 *     every known session is safe: it only writes messages not yet stored.
 *   - There is a hard timeout, so a wedged database cannot stop the container
 *     from ever exiting and turning every deploy into a hang.
 */
function installShutdownFlush(): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received; draining conversation writes`);
    const hard = setTimeout(() => {
      console.warn('[shutdown] timed out draining writes; exiting anyway');
      process.exit(1);
    }, 10000);
    if (hard.unref) hard.unref();
    try {
      const ids = [...conversationManager.getAllConversations().keys()];
      await conversationManager.flushSessions(ids);
      await db().close();
      console.log(`[shutdown] ${signal} handled cleanly`);
    } catch (e) {
      console.warn(`[shutdown] flush failed: ${(e as Error).message}`);
    }
    clearTimeout(hard);
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => { void shutdown(signal); });
  }
}

async function main(): Promise<void> {
  await initDb();
  // Loads any admin-saved token rates before the first request, so the Per Session
  // Cost table does not briefly render at the shipped defaults on a cold start.
  // A failure here must not block boot: the rates service falls back to the
  // environment defaults, which is exactly what it would have used anyway.
  await loadCostRates().catch(() => undefined);
  scheduleRetention();
  scheduleIdleExpiry();
  installShutdownFlush();

  const tlsReady = TLS_CERT_FILE && TLS_KEY_FILE
    && fs.existsSync(TLS_CERT_FILE) && fs.existsSync(TLS_KEY_FILE);

  if (tlsReady) {
    const https = require('https') as typeof import('https');
    https.createServer(
      { key: fs.readFileSync(TLS_KEY_FILE as string), cert: fs.readFileSync(TLS_CERT_FILE as string) },
      app
    ).listen(config.port, () =>
      console.log(`Ami Helpdesk TypeScript server running (HTTPS) on port ${config.port}`));
  } else {
    app.listen(config.port, () =>
      console.log(`Ami Helpdesk TypeScript server running (HTTP) on port ${config.port}`));
  }
}

void main().catch(err => {
  console.error('[startup] fatal:', err);
  process.exit(1);
});

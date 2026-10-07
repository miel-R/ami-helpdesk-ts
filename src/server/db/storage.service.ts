// Storage lifecycle.
//
// This module owns which backend is active and nothing else. Everything else in
// the app calls db() and codes against StorageBackend, so no caller knows - or
// needs to know - whether it is talking to Postgres or to JSON files on disk.
//
// It used to be one 1219-line file holding the contract, the helpers, both
// complete backends and this factory. Adding a field to StorageBackend meant
// reading all of it, and the JSON fallback was maintained alongside the real
// store in the same file even though only one of them ever runs in production.

import { PgBackend } from './postgres.backend';
import { JsonBackend } from './json.backend';
import type { StorageBackend } from './types.model';

let backend: StorageBackend | null = null;
let initPromise: Promise<void> | null = null;

export async function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const url = (process.env.DATABASE_URL || '').trim();
    if (url) {
      try {
        const pgBackend = new PgBackend(url);
        await pgBackend.init();
        backend = pgBackend;
        return;
      } catch (e) {
        // Never take the chat endpoint down because the database is down.
        console.error(`[db] postgres unavailable (${(e as Error).message}) - falling back to JSON store`);
      }
    }
    const jsonBackend = new JsonBackend();
    await jsonBackend.init();
    backend = jsonBackend;
  })();
  return initPromise;
}

export function db(): StorageBackend {
  if (!backend) {
    // Sync access before init() finished: report unavailability rather than
    // throwing deep inside a request.
    throw new Error('db.init() has not completed yet');
  }
  return backend;
}

export function kind(): 'postgres' | 'json' | 'uninitialised' {
  return backend ? backend.kind : 'uninitialised';
}

export async function close(): Promise<void> {
  if (backend) await backend.close();
}

// Re-exported so callers have one import site for storage, and so the existing
// `from '../db/storage.service'` imports keep working now that the implementation is split up.
export { PgBackend, JsonBackend };
export type {
  StorageBackend, UserRecord, UserPatch, UserProfile, UsageEntry, UsageEntryInput,
  ConversationStateMeta, ConversationRow, ConversationState, MessagePage,
  SummaryBucket, UsageSummary, ListConversationsOptions, PageMessagesOptions,
  ListMessagesOptions, SummaryOptions, StoredMessage, StoredConversationRow,
  ConversationPersistInput, ConversationPersistResult, StorageHealth
} from './types.model';
export { REQUIRED_TABLES } from './types.model';

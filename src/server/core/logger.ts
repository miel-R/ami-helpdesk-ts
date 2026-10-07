// In-memory structured log with counters, read by the admin dashboard.

export const MAX_LOG_LINES = 2000;

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  detail: Record<string, unknown>;
}

export interface Counters {
  totalRequests: number;
  chatRequests: number;
  errors: number;
  aiCalls: number;
  aiErrors: number;
  aiMsTotal: number;
  uploads: number;
  uploadBytes: number;
  ticketsCreated: number;
  ticketsFailed: number;
}

/**
 * Bounded so a long-running container cannot grow without limit. shift() on an
 * array is O(n), but at 2000 entries with one write per request that is cheaper
 * than the alternative of an index-based ring buffer needing a rewrite of every
 * reader.
 */
const requestLog: LogEntry[] = [];

export const serverStartedAt = Date.now();

export const counters: Counters = {
  totalRequests: 0,
  chatRequests: 0,
  errors: 0,
  aiCalls: 0,
  aiErrors: 0,
  aiMsTotal: 0,
  uploads: 0,
  uploadBytes: 0,
  ticketsCreated: 0,
  ticketsFailed: 0
};

export function logEvent(
  level: LogLevel,
  event: string,
  detail: Record<string, unknown> = {}
): LogEntry {
  const entry: LogEntry = { ts: new Date().toISOString(), level, event, detail };
  requestLog.push(entry);
  if (requestLog.length > MAX_LOG_LINES) requestLog.shift();
  if (level === 'error') console.error(`[${entry.ts}] ${event}`, detail);
  else if (level === 'warn') console.warn(`[${entry.ts}] ${event}`, detail);
  else console.log(`[${entry.ts}] ${event}`, detail);
  return entry;
}

export function getRequestLog(): LogEntry[] {
  return requestLog;
}
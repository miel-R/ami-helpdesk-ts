// Live pulse: active sessions, last-minute rate, memory, recent events.
import { counters, getRequestLog, serverStartedAt } from '../core/logger';
import type { AnalyticsRealtime } from '../models/analytics.model';

export async function buildRealtime(): Promise<AnalyticsRealtime> {
  const log = getRequestLog();
  const now = Date.now();
  const activeCutoff = new Date(now - 15 * 60 * 1000).toISOString();
  const minuteCutoff = new Date(now - 60 * 1000).toISOString();
  const activeSessions = new Set<string>();
  let lastMinute = 0;
  for (const e of log) {
    if (e.ts < activeCutoff) continue;
    const sid = (e.detail as Record<string, unknown>).session_id ?? (e.detail as Record<string, unknown>).sessionId;
    if (typeof sid === 'string' && sid) activeSessions.add(sid);
    if (e.ts >= minuteCutoff && e.event === 'http') lastMinute++;
  }
  return {
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((now - serverStartedAt) / 1000),
    active_sessions_15min: activeSessions.size,
    requests_last_minute: lastMinute,
    memory_mb: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    counters: { ...(counters as unknown as Record<string, number>) },
    recent_events: log.slice(-50).reverse().map(e => ({ ts: e.ts, level: e.level, event: e.event, detail: e.detail })),
  };
}

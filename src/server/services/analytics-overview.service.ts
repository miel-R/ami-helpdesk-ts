// Headline KPIs + zero-filled per-day timeseries.
import { db } from '../db/storage.service';
import { getRequestLog } from '../core/logger';
import type { AnalyticsOverview, AnalyticsTimeseries, Kpi, TimeseriesPoint } from '../models/analytics.model';
import { avg, dayKey, deltaPct, eachDay, fmtInt, fmtUsd, num, roundCost } from './analytics-helpers';

function kpi(value: number, display: string, prev: number, spark?: number[]): Kpi {
  return { value, display, delta_pct: deltaPct(value, prev), spark };
}

export async function buildOverview(days: number, username: string | null): Promise<AnalyticsOverview> {
  const cur = await db().summary({ days, username });
  const wide = await db().summary({ days: days * 2, username });
  const prevCalls = Math.max(0, num(wide.calls) - num(cur.calls));
  const prevTokens = Math.max(0, num(wide.total) - num(cur.total));
  const prevCost = Math.max(0, num(wide.cost) - num(cur.cost));
  const total = num(cur.total);
  const cost = num(cur.cost);
  const calls = num(cur.calls);
  const log = getRequestLog();
  const cutoff = Date.now() - days * 86_400_000;
  const recent = log.filter(e => new Date(e.ts).getTime() >= cutoff);
  const httpEvents = recent.filter(e => e.event === 'http');
  const chatEvents = httpEvents.filter(e => String((e.detail as Record<string, unknown>).path || '').startsWith('/api/chat'));
  const errEvents = recent.filter(e => e.level === 'error');
  const lats = httpEvents.map(e => num((e.detail as Record<string, unknown>).ms, NaN)).filter(Number.isFinite);
  const avgLatency = avg(lats);
  const tickets = recent.filter(e => e.event === 'ticket_created' || e.event === 'ticket_ok');
  const ticketFails = recent.filter(e => e.event === 'ticket_failed' || e.event === 'ticket_error').length;
  const uploads = recent.filter(e => e.event === 'upload' || e.event === 'file_uploaded');
  const spark = cur.byDay.slice(-14).map(b => num(b.calls));
  const errRate = httpEvents.length ? Math.round((errEvents.length / httpEvents.length) * 1000) / 10 : 0;
  return {
    timestamp: new Date().toISOString(), days, username,
    kpis: {
      total_requests: kpi(httpEvents.length, fmtInt(httpEvents.length), Math.max(0, log.length - recent.length)),
      chat_requests: kpi(chatEvents.length, fmtInt(chatEvents.length), 0),
      ai_calls: kpi(calls, fmtInt(calls), prevCalls, spark),
      total_tokens: kpi(total, fmtInt(total), prevTokens),
      cost_usd: kpi(cost, fmtUsd(cost), prevCost),
      active_users: kpi(cur.byUser.length, fmtInt(cur.byUser.length), 0),
      sessions: kpi(cur.bySession.length, fmtInt(cur.bySession.length), 0),
      tickets_created: kpi(tickets.length, fmtInt(tickets.length), 0),
      error_rate: kpi(errRate, `${errRate.toFixed(1)}%`, 0),
      avg_latency_ms: kpi(avgLatency, `${fmtInt(avgLatency)} ms`, 0),
    },
    totals: {
      input_tokens: num(cur.input), output_tokens: num(cur.output), total_tokens: total,
      cost_usd: cost, calls, sessions: cur.bySession.length, active_users: cur.byUser.length,
      tickets_created: tickets.length, tickets_failed: ticketFails, uploads: uploads.length,
      upload_bytes: uploads.reduce((a, e) => a + num((e.detail as Record<string, unknown>).bytes ?? (e.detail as Record<string, unknown>).size), 0),
      errors: errEvents.length, ai_errors: recent.filter(e => e.event === 'ai_error').length,
    },
    prev_totals: { calls: prevCalls, total_tokens: prevTokens, cost_usd: prevCost },
  };
}

export async function buildTimeseries(days: number, username: string | null): Promise<AnalyticsTimeseries> {
  const summary = await db().summary({ days, username });
  const todayStr = new Date().toISOString().slice(0, 10);
  const start = new Date(`${todayStr}T00:00:00.000Z`).getTime() - (days - 1) * 86_400_000;
  const labels = eachDay(new Date(start).toISOString().slice(0, 10), days);
  const byDay = new Map(summary.byDay.map(b =>
    [String(b.k), { calls: num(b.calls), input: num(b.input), output: num(b.output), cost: num(b.cost) }] as const));
  const log = getRequestLog();
  const latByDay = new Map<string, number[]>();
  const sessByDay = new Map<string, Set<string>>();
  for (const e of log) {
    const k = dayKey(e.ts);
    if (!k) continue;
    if (e.event === 'http') {
      const ms = num((e.detail as Record<string, unknown>).ms, NaN);
      if (Number.isFinite(ms)) {
        if (!latByDay.has(k)) latByDay.set(k, []);
        latByDay.get(k)!.push(ms);
      }
    }
    const sid = (e.detail as Record<string, unknown>).session_id ?? (e.detail as Record<string, unknown>).sessionId;
    if (typeof sid === 'string' && sid) {
      if (!sessByDay.has(k)) sessByDay.set(k, new Set());
      sessByDay.get(k)!.add(sid);
    }
  }
  const ledgerByDay = new Map<string, Set<string>>();
  for (const s of summary.bySession) {
    const k = dayKey(s.last_at ?? null) ?? todayStr;
    if (!ledgerByDay.has(k)) ledgerByDay.set(k, new Set());
    ledgerByDay.get(k)!.add(String(s.k));
  }
  const points: TimeseriesPoint[] = labels.map(day => {
    const b = byDay.get(day) ?? { calls: 0, input: 0, output: 0, cost: 0 };
    const lats = latByDay.get(day) ?? [];
    const sess = new Set<string>([...(sessByDay.get(day) ?? []), ...(ledgerByDay.get(day) ?? [])]);
    return {
      day, calls: b.calls, input_tokens: b.input, output_tokens: b.output,
      total_tokens: b.input + b.output, cost_usd: roundCost(b.cost),
      sessions: sess.size, avg_latency_ms: avg(lats),
    };
  });
  return { timestamp: new Date().toISOString(), days, granularity: 'day', username, points };
}

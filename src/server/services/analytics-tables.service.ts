// Per-user + per-session rollups joining the users table with the ledger.
import { db } from '../db/storage.service';
import { config } from '../config/config.service';
import type { AnalyticsSessions, AnalyticsUsers } from '../models/analytics.model';
import { avg, num, roundCost } from './analytics-helpers';

export async function buildUsers(days: number): Promise<AnalyticsUsers> {
  const users = await db().listUsers();
  const summary = await db().summary({ days });
  const byUser = new Map(summary.byUser.map(u => [String(u.k), u]));
  const day = new Date().toISOString().slice(0, 10);
  const ledger = await db().listMessages({ limit: 1000 });
  const latByUser = new Map<string, number[]>();
  const sessByUser = new Map<string, Set<string>>();
  const lastByUser = new Map<string, string>();
  for (const m of ledger) {
    const u = String(m.username || 'unknown');
    if (m.duration_ms) {
      if (!latByUser.has(u)) latByUser.set(u, []);
      latByUser.get(u)!.push(num(m.duration_ms));
    }
    if (m.session_id) {
      if (!sessByUser.has(u)) sessByUser.set(u, new Set());
      sessByUser.get(u)!.add(String(m.session_id));
    }
    const ts = String(m.created_at || '');
    if (ts && (!lastByUser.has(u) || ts > lastByUser.get(u)!)) lastByUser.set(u, ts);
  }
  const rows: AnalyticsUsers['users'] = [];
  for (const u of users) {
    const b = byUser.get(u.username);
    const requestsToday = await db().getRequestUsage(u.username, day);
    const limit = u.role === 'admin' ? null : (u.requests_per_day ?? config.rateLimit.requestsPerDay);
    rows.push({
      username: u.username, display_name: u.display_name || u.username, department: u.department || '',
      role: u.role || 'user', enabled: u.enabled !== false,
      calls: num(b?.calls), input_tokens: num(b?.input), output_tokens: num(b?.output),
      total_tokens: num(b?.input) + num(b?.output), cost_usd: roundCost(b?.cost),
      sessions: sessByUser.get(u.username)?.size ?? 0, requests_today: requestsToday,
      requests_limit: limit, requests_remaining: limit === null ? null : Math.max(0, limit - requestsToday),
      avg_latency_ms: avg(latByUser.get(u.username) ?? []),
      last_seen: u.last_seen || null, last_active: lastByUser.get(u.username) ?? null,
    });
  }
  for (const [name, b] of byUser) {
    if (rows.some(r => r.username === name)) continue;
    rows.push({
      username: name, display_name: name, department: '', role: 'user', enabled: true,
      calls: num(b.calls), input_tokens: num(b.input), output_tokens: num(b.output),
      total_tokens: num(b.input) + num(b.output), cost_usd: roundCost(b.cost),
      sessions: sessByUser.get(name)?.size ?? 0, requests_today: 0,
      requests_limit: config.rateLimit.requestsPerDay, requests_remaining: config.rateLimit.requestsPerDay,
      avg_latency_ms: avg(latByUser.get(name) ?? []),
      last_seen: null, last_active: lastByUser.get(name) ?? null,
    });
  }
  rows.sort((a, b) => b.cost_usd - a.cost_usd);
  return { timestamp: new Date().toISOString(), days, count: rows.length, users: rows };
}

export async function buildSessions(limit: number): Promise<AnalyticsSessions> {
  const convs = await db().listConversations({ limit });
  const ledger = await db().listMessages({ limit: 1000 });
  const agg = new Map<string, { calls: number; input: number; output: number; cost: number; lat: number[] }>();
  for (const m of ledger) {
    const sid = String(m.session_id || '');
    if (!sid) continue;
    if (!agg.has(sid)) agg.set(sid, { calls: 0, input: 0, output: 0, cost: 0, lat: [] });
    const a = agg.get(sid)!;
    a.calls++; a.input += num(m.input_tokens); a.output += num(m.output_tokens); a.cost += num(m.cost_usd);
    if (m.duration_ms) a.lat.push(num(m.duration_ms));
  }
  const sessions = convs.map(c => {
    const a = agg.get(c.session_id) ?? { calls: 0, input: 0, output: 0, cost: 0, lat: [] as number[] };
    const state = (c.state ?? {}) as Record<string, unknown>;
    const stateUser = (state.user ?? {}) as Record<string, unknown>;
    return {
      session_id: c.session_id,
      user: c.username || String(stateUser.user_name ?? 'unknown'),
      mode: c.mode, status: c.status, messages: num(c.message_count),
      ai_calls: a.calls, input_tokens: a.input, output_tokens: a.output,
      total_tokens: a.input + a.output, cost_usd: roundCost(a.cost),
      avg_latency_ms: avg(a.lat), created_at: c.created_at,
      last_activity: c.last_message_at || c.updated_at,
    };
  });
  return { timestamp: new Date().toISOString(), count: sessions.length, sessions };
}

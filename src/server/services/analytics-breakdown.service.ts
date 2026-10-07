// Ranked breakdowns by model / user / session / kind.
import { db } from '../db/storage.service';
import type { AnalyticsBreakdown, BreakdownRow } from '../models/analytics.model';
import { avg, num, roundCost } from './analytics-helpers';

export async function buildBreakdown(days: number, username: string | null, top = 50): Promise<AnalyticsBreakdown> {
  const summary = await db().summary({ days, username });
  const ledger = await db().listMessages({ username, limit: 1000 });
  const latModel = new Map<string, number[]>();
  const latSession = new Map<string, number[]>();
  const kindAgg = new Map<string, { calls: number; input: number; output: number; cost: number }>();
  for (const m of ledger) {
    const model = String(m.model || m.provider || 'unknown');
    if (!latModel.has(model)) latModel.set(model, []);
    if (m.duration_ms) latModel.get(model)!.push(num(m.duration_ms));
    const sid = String(m.session_id || 'unknown');
    if (!latSession.has(sid)) latSession.set(sid, []);
    if (m.duration_ms) latSession.get(sid)!.push(num(m.duration_ms));
    const kind = String(m.kind || 'chat');
    if (!kindAgg.has(kind)) kindAgg.set(kind, { calls: 0, input: 0, output: 0, cost: 0 });
    const k = kindAgg.get(kind)!;
    k.calls++; k.input += num(m.input_tokens); k.output += num(m.output_tokens); k.cost += num(m.cost_usd);
  }
  const toRow = (
    b: { k: string; calls: number; input: number; output: number; cost: number; last_at?: string | null },
    lat?: number,
  ): BreakdownRow => ({
    key: String(b.k), calls: num(b.calls), input_tokens: num(b.input), output_tokens: num(b.output),
    total_tokens: num(b.input) + num(b.output), cost_usd: roundCost(b.cost),
    avg_latency_ms: lat ?? 0, last_at: b.last_at ?? null,
  });
  const byModel = summary.byModel.map(b => toRow(b, avg(latModel.get(String(b.k)) ?? [])))
    .sort((a, b) => b.cost_usd - a.cost_usd).slice(0, top);
  const byUser = summary.byUser.map(b => toRow(b))
    .sort((a, b) => b.cost_usd - a.cost_usd).slice(0, top);
  const bySession = summary.bySession.map(b => toRow(b, avg(latSession.get(String(b.k)) ?? [])))
    .sort((a, b) => b.cost_usd - a.cost_usd).slice(0, top);
  const byKind: BreakdownRow[] = [...kindAgg.entries()].map(([key, v]) => ({
    key, calls: v.calls, input_tokens: v.input, output_tokens: v.output,
    total_tokens: v.input + v.output, cost_usd: roundCost(v.cost),
  })).sort((a, b) => b.calls - a.calls);
  return { timestamp: new Date().toISOString(), days, by_model: byModel, by_user: byUser, by_session: bySession, by_kind: byKind };
}

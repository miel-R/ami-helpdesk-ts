// Shared analytics shapes for the dashboard frontend.
// Mirrors src/server/models/analytics.model.ts. Kept as a local copy (rather
// than importing the server file) so the dashboard compiles standalone with
// tsconfig.dashboard.json and never pulls server code into the browser.
export interface Kpi { value: number; display: string; delta_pct: number | null; spark?: number[]; }
export interface TimeseriesPoint {
  day: string; calls: number; input_tokens: number; output_tokens: number;
  total_tokens: number; cost_usd: number; sessions: number; avg_latency_ms: number;
}
export interface BreakdownRow {
  key: string; calls: number; input_tokens: number; output_tokens: number;
  total_tokens: number; cost_usd: number; avg_latency_ms?: number; last_at?: string | null;
}
export interface AnalyticsOverview {
  timestamp: string; days: number; username: string | null;
  kpis: Record<string, Kpi>;
  totals: Record<string, number>;
}
export interface AnalyticsTimeseries { timestamp: string; days: number; points: TimeseriesPoint[]; }
export interface AnalyticsBreakdown {
  timestamp: string; days: number;
  by_model: BreakdownRow[]; by_user: BreakdownRow[]; by_session: BreakdownRow[]; by_kind: BreakdownRow[];
}
export interface AnalyticsRealtime {
  timestamp: string; uptime_seconds: number; active_sessions_15min: number;
  requests_last_minute: number; memory_mb: { rss: number; heapUsed: number };
  counters: Record<string, number>; recent_events: Array<{ ts: string; level: string; event: string; detail: Record<string, unknown> }>;
}
export interface AnalyticsUserRow {
  username: string; display_name: string; department: string; role: string; enabled: boolean;
  calls: number; input_tokens: number; output_tokens: number; total_tokens: number; cost_usd: number;
  sessions: number; requests_today: number; requests_limit: number | null; requests_remaining: number | null;
  avg_latency_ms: number; last_seen: string | null; last_active: string | null;
}
export interface AnalyticsUsers { timestamp: string; days: number; count: number; users: AnalyticsUserRow[]; }
export interface AnalyticsSessionRow {
  session_id: string; user: string; mode: string; status: string; messages: number;
  ai_calls: number; input_tokens: number; output_tokens: number; total_tokens: number;
  cost_usd: number; avg_latency_ms: number; created_at: string | null; last_activity: string | null;
}
export interface AnalyticsSessions { timestamp: string; count: number; sessions: AnalyticsSessionRow[]; }

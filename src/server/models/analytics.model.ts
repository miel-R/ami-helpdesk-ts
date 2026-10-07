// Shared analytics shapes: one definition for the controller and the dashboard.
// The dashboard TS modules import these types only (erased at compile time),
// so this file never ships to the browser.

/** Query knobs every analytics endpoint honours. */
export interface AnalyticsQuery {
  days: number;
  username: string | null;
}

/** One zero-filled day bucket in a timeseries. */
export interface TimeseriesPoint {
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  sessions: number;
  avg_latency_ms: number;
}

/** KPI card with a delta vs the previous equal-length period. */
export interface Kpi {
  value: number;
  display: string;
  /** Percent change vs previous period; null when there is no previous data. */
  delta_pct: number | null;
  spark?: number[];
}

/** GET /api/analytics/overview */
export interface AnalyticsOverview {
  timestamp: string;
  days: number;
  username: string | null;
  kpis: {
    total_requests: Kpi;
    chat_requests: Kpi;
    ai_calls: Kpi;
    total_tokens: Kpi;
    cost_usd: Kpi;
    active_users: Kpi;
    sessions: Kpi;
    tickets_created: Kpi;
    error_rate: Kpi;
    avg_latency_ms: Kpi;
  };
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    calls: number;
    sessions: number;
    active_users: number;
    tickets_created: number;
    tickets_failed: number;
    uploads: number;
    upload_bytes: number;
    errors: number;
    ai_errors: number;
  };
  prev_totals: {
    calls: number;
    total_tokens: number;
    cost_usd: number;
  };
}

/** GET /api/analytics/timeseries */
export interface AnalyticsTimeseries {
  timestamp: string;
  days: number;
  granularity: 'day';
  username: string | null;
  points: TimeseriesPoint[];
}

/** One ranked row in a breakdown table. */
export interface BreakdownRow {
  key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  avg_latency_ms?: number;
  last_at?: string | null;
}

/** GET /api/analytics/breakdown */
export interface AnalyticsBreakdown {
  timestamp: string;
  days: number;
  by_model: BreakdownRow[];
  by_user: BreakdownRow[];
  by_session: BreakdownRow[];
  by_kind: BreakdownRow[];
}

/** GET /api/analytics/realtime — what is happening RIGHT NOW. */
export interface RealtimeEvent {
  ts: string;
  level: string;
  event: string;
  detail: Record<string, unknown>;
}

export interface AnalyticsRealtime {
  timestamp: string;
  uptime_seconds: number;
  active_sessions_15min: number;
  requests_last_minute: number;
  memory_mb: { rss: number; heapUsed: number };
  counters: Record<string, number>;
  recent_events: RealtimeEvent[];
}

/** GET /api/analytics/users — per-user rollup for the table. */
export interface AnalyticsUserRow {
  username: string;
  display_name: string;
  department: string;
  role: string;
  enabled: boolean;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  sessions: number;
  requests_today: number;
  requests_limit: number | null;
  requests_remaining: number | null;
  avg_latency_ms: number;
  last_seen: string | null;
  last_active: string | null;
}

export interface AnalyticsUsers {
  timestamp: string;
  days: number;
  count: number;
  users: AnalyticsUserRow[];
}

/** GET /api/analytics/sessions — enriched conversation list. */
export interface AnalyticsSessionRow {
  session_id: string;
  user: string;
  mode: string;
  status: string;
  messages: number;
  ai_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
  created_at: string | null;
  last_activity: string | null;
}

export interface AnalyticsSessions {
  timestamp: string;
  count: number;
  sessions: AnalyticsSessionRow[];
}

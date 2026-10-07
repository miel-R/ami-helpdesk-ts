// Tab: Overview — 10 KPI cards with deltas + period totals + system health.
import { api } from '../api';
import { deltaPill, esc, must, nfmt, usd } from '../utils';
import { sparkline } from '../charts';
import type { AnalyticsOverview, Kpi } from '../types';

export interface OverviewFilter { days: number; username: string | null; }

function kpiCard(id: string, title: string, icon: string, k: Kpi, invert = false, sparkId?: string): string {
  return `<div class="col-6 col-md-4 col-xl-2dot4">
    <div class="card metric-card border-0 shadow-sm rounded-3 h-100">
      <div class="card-body p-3">
        <div class="d-flex justify-content-between align-items-start mb-1">
          <span class="metric-title">${esc(title)}</span>
          <i class="bi ${esc(icon)} text-ami"></i>
        </div>
        <div class="metric-value" id="${esc(id)}">${esc(k.display)}</div>
        <div class="d-flex justify-content-between align-items-center mt-1">
          ${deltaPill(k.delta_pct, invert)}
          ${sparkId ? `<canvas id="${esc(sparkId)}" style="width:72px;height:24px"></canvas>` : '<span class="small text-muted">vs prev</span>'}
        </div>
      </div>
    </div>
  </div>`;
}

export async function renderOverview(f: OverviewFilter): Promise<void> {
  const host = must('kpiRow');
  host.innerHTML = '<div class="col-12 text-muted small py-3">Loading overview…</div>';
  const q = `?days=${f.days}` + (f.username ? `&username=${encodeURIComponent(f.username)}` : '');
  const ov = await api<AnalyticsOverview>('/api/analytics/overview' + q);
  const k = ov.kpis;
  host.innerHTML =
    kpiCard('kpiReq', 'Requests', 'bi-arrow-down-up', k.total_requests) +
    kpiCard('kpiChat', 'Chat turns', 'bi-chat-dots', k.chat_requests) +
    kpiCard('kpiCalls', 'AI calls', 'bi-cpu', k.ai_calls, false, 'sparkCalls') +
    kpiCard('kpiTok', 'Tokens', 'bi-lightning', k.total_tokens) +
    kpiCard('kpiCost', 'Cost', 'bi-cash-coin', k.cost_usd, true) +
    kpiCard('kpiUsers', 'Active users', 'bi-people', k.active_users) +
    kpiCard('kpiSess', 'Sessions', 'bi-collection', k.sessions) +
    kpiCard('kpiTick', 'Tickets', 'bi-ticket-detailed', k.tickets_created) +
    kpiCard('kpiErr', 'Error rate', 'bi-exclamation-triangle', k.error_rate, true) +
    kpiCard('kpiLat', 'Avg latency', 'bi-speedometer2', k.avg_latency_ms, true);
  if (k.ai_calls.spark?.length) sparkline('sparkCalls', k.ai_calls.spark);

  const t = ov.totals;
  const totalsHtml = [
    ['Input tokens', nfmt(t.input_tokens)], ['Output tokens', nfmt(t.output_tokens)],
    ['Total tokens', nfmt(t.total_tokens)], ['Cost', usd(t.cost_usd)],
    ['AI calls', nfmt(t.calls)], ['Sessions', nfmt(t.sessions)],
    ['Tickets ok', nfmt(t.tickets_created)], ['Tickets failed', nfmt(t.tickets_failed)],
    ['Uploads', nfmt(t.uploads)], ['Errors', nfmt(t.errors)],
  ].map(([label, val]) =>
    `<div class="d-flex justify-content-between border-bottom py-1"><span class="text-muted small">${esc(label)}</span><strong class="mono">${esc(val)}</strong></div>`
  ).join('');
  must('periodTotals').innerHTML = totalsHtml
    + `<div class="small text-muted mt-2">Window: last ${esc(String(ov.days))} day(s)${ov.username ? ` · user: ${esc(ov.username)}` : ''}</div>`;

  // System health strip
  try {
    const health = await api<{ status: string; uptime_seconds: number; tls: boolean; storage: string; memory_mb: { rss: number; heapUsed: number } }>('/api/health');
    must('sysHealth').innerHTML =
      `<span class="badge ${health.status === 'ok' ? 'bg-success' : 'bg-danger'}">${esc(health.status)}</span> ` +
      `<span class="small text-muted">up ${esc(String(Math.floor(health.uptime_seconds / 60)))}m · ${esc(health.storage)} · TLS ${health.tls ? 'on' : 'off'} · RSS ${esc(String(health.memory_mb.rss))} MB</span>`;
  } catch { must('sysHealth').innerHTML = '<span class="badge bg-warning">health unavailable</span>'; }
}

// Tab: Overview — 10 KPI cards with deltas + period totals + system health.
import { api } from '../api.js';
import { deltaPill, esc, must, nfmt, usd } from '../utils.js';
import { sparkline } from '../charts.js';
function kpiCard(id, title, icon, k, invert = false, sparkId) {
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
export async function renderOverview(f) {
    const host = must('kpiRow');
    host.innerHTML = '<div class="col-12 text-muted small py-3">Loading overview...</div>';
    const q = `?days=${f.days}` + (f.username ? `&username=${encodeURIComponent(f.username)}` : '');
    const ov = await api('/api/analytics/overview' + q);
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
    if (k.ai_calls.spark?.length)
        sparkline('sparkCalls', k.ai_calls.spark);
    const t = ov.totals;
    const totalsHtml = [
        ['Input tokens', nfmt(t.input_tokens)], ['Output tokens', nfmt(t.output_tokens)],
        ['Total tokens', nfmt(t.total_tokens)], ['Cost', usd(t.cost_usd)],
        ['AI calls', nfmt(t.calls)], ['Sessions', nfmt(t.sessions)],
        ['Tickets ok', nfmt(t.tickets_created)], ['Tickets failed', nfmt(t.tickets_failed)],
        ['Uploads', nfmt(t.uploads)], ['Errors', nfmt(t.errors)],
    ].map(([label, val]) => `<div class="d-flex justify-content-between border-bottom py-1"><span class="text-muted small">${esc(label)}</span><strong class="mono">${esc(val)}</strong></div>`).join('');
    must('periodTotals').innerHTML = totalsHtml
        + `<div class="small text-muted mt-2">Window: last ${esc(String(ov.days))} day(s)${ov.username ? ` · user: ${esc(ov.username)}` : ''}</div>`;
    // System health - enhanced with PostgreSQL and Chatbot metrics
    try {
        const health = await api('/api/health');
        const sysHealth = await api('/api/system/health');
        const healthHtml = `
      <span class="badge ${health.status === 'ok' ? 'bg-success' : 'bg-danger'}">${esc(health.status)}</span>
      <span class="small text-muted ms-2">up ${esc(String(Math.floor(health.uptime_seconds / 60)))}m \u00b7 ${esc(health.storage)} \u00b7 TLS ${health.tls ? 'on' : 'off'} \u00b7 RSS ${esc(String(health.memory_mb.rss))} MB</span>
    `;
        const pg = sysHealth.postgresql;
        const cb = sysHealth.chatbot;
        const node = sysHealth.node;
        function systemHealthCard(label, value, icon, color) {
            return `<div class="col-6 col-md-4 col-xl-3">
        <div class="card metric-card border-0 shadow-sm rounded-3 h-100">
          <div class="card-body p-3">
            <div class="d-flex justify-content-between align-items-start mb-1">
              <span class="metric-title">${esc(label)}</span>
              <i class="bi ${esc(icon)} ${esc(color)}"></i>
            </div>
            <div class="metric-value">${esc(value)}</div>
          </div>
        </div>
      </div>`;
        }
        const pgHtml = systemHealthCard('PostgreSQL', pg.status, 'bi-database', 'text-primary')
            + systemHealthCard('PG Connections', pg.connections, 'bi-hdd-network', 'text-info')
            + systemHealthCard('PG Storage', pg.storage_size, 'bi-hdd', 'text-warning')
            + systemHealthCard('PG Used', pg.storage_used, 'bi-hdd-fill', 'text-warning');
        const cbHtml = systemHealthCard('Chatbot CPU', cb.cpu_usage + '%', 'bi-cpu', 'text-danger')
            + systemHealthCard('Chatbot Memory', cb.memory_usage + ' MB', 'bi-memory', 'text-success')
            + systemHealthCard('Chatbot RSS', cb.memory_rss + ' MB', 'bi-memory', 'text-info')
            + systemHealthCard('Active Sessions', String(cb.active_sessions), 'bi-people', 'text-primary')
            + systemHealthCard('Total Messages', nfmt(sysHealth.chatbot?.total_messages || 0), 'bi-chat', 'text-info')
            + systemHealthCard('Total Tokens', nfmt(sysHealth.chatbot?.total_tokens || 0), 'bi-lightning', 'text-warning')
            + systemHealthCard('AI Calls', nfmt(sysHealth.chatbot?.total_calls || 0), 'bi-cpu', 'text-secondary')
            + systemHealthCard('Chatbot Cost', sysHealth.chatbot?.estimated_cost_usd ? usd(sysHealth.chatbot.estimated_cost_usd) : '$0.00', 'bi-cash', 'text-success')
            + systemHealthCard('Uptime', String(Math.floor(cb.uptime_seconds / 60)) + 'm', 'bi-clock', 'text-muted');
        const nodeHtml = systemHealthCard('Node PID', String(node.pid), 'bi-terminal', 'text-muted')
            + systemHealthCard('Node Version', node.version, 'bi-code', 'text-muted')
            + systemHealthCard('Platform', node.platform, 'bi-window', 'text-muted')
            + systemHealthCard('Node Uptime', Math.floor(node.uptime_seconds / 60) + 'm', 'bi-clock', 'text-muted');
        must('sysHealth').innerHTML = healthHtml
            + `<hr class="my-2">`
            + `<div class="row g-2 mb-2">${pgHtml}</div>`
            + `<div class="row g-2 mb-2">${cbHtml}</div>`
            + `<div class="row g-2">${nodeHtml}</div>`;
    }
    catch (e) {
        must('sysHealth').innerHTML = '<span class="badge bg-warning">health unavailable</span>';
        console.error('[overview] system health error:', e);
    }
}
//# sourceMappingURL=overview.js.map
// Tab: Live — realtime pulse (active sessions, rpm, memory, event stream).
import { api } from '../api.js';
import { esc, must, nfmt, uptime, when } from '../utils.js';
import { renderRateCard } from './rates.js';
function lvlBadge(lvl) {
    if (lvl === 'error')
        return '<span class="badge bg-danger">error</span>';
    if (lvl === 'warn')
        return '<span class="badge bg-warning text-dark">warn</span>';
    return '<span class="badge bg-info text-dark">info</span>';
}
export async function renderRealtime() {
    const rt = await api('/api/analytics/realtime');
    must('livePulse').innerHTML =
        `<span class="badge bg-success fs-6">${nfmt(rt.active_sessions_15min)} active</span> ` +
            `<span class="badge bg-primary fs-6">${nfmt(rt.requests_last_minute)} req/min</span> ` +
            `<span class="badge bg-secondary fs-6">up ${esc(uptime(rt.uptime_seconds))}</span> ` +
            `<span class="badge bg-secondary fs-6">RSS ${nfmt(rt.memory_mb.rss)} MB</span>`;
    // Rates are a separate request and a separate failure. renderRealtime is called
    // on a 15s timer, so letting a rate-read error reject here would blank the
    // counters on every tick; the card degrades on its own instead.
    void renderRateCard();
    const c = rt.counters;
    must('liveCounters').innerHTML = ['totalRequests', 'chatRequests', 'aiCalls', 'aiErrors', 'errors', 'ticketsCreated', 'ticketsFailed', 'uploads']
        .map(k => `<div class="d-flex justify-content-between border-bottom py-1">
      <span class="text-muted small">${esc(k)}</span><strong class="mono">${nfmt(c[k] ?? 0)}</strong></div>`).join('');
    must('liveEvents').innerHTML = rt.recent_events.slice(0, 30).map(e => `<div class="d-flex gap-2 py-1 border-bottom small">
      <span class="text-muted mono" style="min-width:70px">${esc(e.ts.slice(11, 19))}</span>
      ${lvlBadge(e.level)}
      <span class="mono">${esc(e.event)}</span>
    </div>`).join('') || '<div class="text-muted small">No recent events</div>';
    must('liveMeta').textContent = `Updated ${when(rt.timestamp)}`;
}
//# sourceMappingURL=realtime.js.map
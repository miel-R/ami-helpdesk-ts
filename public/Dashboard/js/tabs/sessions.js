// Tab: Sessions — enriched conversation list with cost + drill-down.
import { api, flash } from '../api';
import { ago, esc, must, nfmt, usd } from '../utils';
function statusBadge(s) {
    if (s === 'escalated')
        return '<span class="badge bg-warning text-dark">escalated</span>';
    if (s === 'ended')
        return '<span class="badge bg-secondary">ended</span>';
    return '<span class="badge bg-success">active</span>';
}
export async function renderSessions(limit = 100) {
    const host = must('convBody');
    host.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">Loading sessions…</td></tr>';
    try {
        const data = await api('/api/analytics/sessions?limit=' + limit);
        must('sessionsMeta').textContent = `${data.count} session(s)`;
        host.innerHTML = data.sessions.map(s => `<tr>
      <td class="mono small">${esc(s.session_id.slice(0, 12))}…</td>
      <td>${esc(s.user)}</td>
      <td><span class="badge bg-light text-dark border">${esc(s.mode)}</span></td>
      <td>${statusBadge(s.status)}</td>
      <td class="text-end">${nfmt(s.messages)}</td>
      <td class="text-end">${nfmt(s.ai_calls)}</td>
      <td class="text-end">${nfmt(s.total_tokens)}</td>
      <td class="text-end">${usd(s.cost_usd)}</td>
      <td class="text-end small">${s.last_activity ? esc(ago(s.last_activity)) : '—'}</td>
      <td class="text-end"><button class="btn btn-sm btn-outline-secondary" data-session="${esc(s.session_id)}"><i class="bi bi-eye"></i></button></td>
    </tr>`).join('') || '<tr><td colspan="10" class="text-center text-muted py-3">No sessions</td></tr>';
    }
    catch (e) {
        host.innerHTML = '<tr><td colspan="10" class="text-center text-danger py-3">Failed to load sessions</td></tr>';
        flash('err', e.message);
    }
}
//# sourceMappingURL=sessions.js.map
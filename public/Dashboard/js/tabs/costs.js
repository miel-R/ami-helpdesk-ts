// Tab: Costs — ranked breakdowns (model / user / session / kind) + doughnut.
import { api, flash } from '../api';
import { ago, esc, must, nfmt, usd, when } from '../utils';
import { doughnutChart } from '../charts';
const PALETTE = ['#6f42c1', '#0dcaf0', '#198754', '#fd7e14', '#dc3545', '#6c757d', '#ffc107', '#0d6efd'];
function rows(list, showLast, clickUser) {
    if (!list.length)
        return '<tr><td colspan="7" class="text-center text-muted py-3">No data in this window</td></tr>';
    return list.map(r => `<tr>
    <td class="mono">${clickUser ? `<a href="#" data-filteruser="${esc(r.key)}">${esc(r.key)}</a>` : esc(r.key)}</td>
    <td class="text-end">${nfmt(r.calls)}</td>
    <td class="text-end">${nfmt(r.total_tokens)}</td>
    <td class="text-end">${usd(r.cost_usd)}</td>
    <td class="text-end">${r.avg_latency_ms ? nfmt(r.avg_latency_ms) + ' ms' : '—'}</td>
    ${showLast ? `<td class="text-end small">${r.last_at ? esc(ago(r.last_at)) : '—'}</td>` : ''}
  </tr>`).join('');
}
export async function renderCosts(f) {
    const q = `?days=${f.days}` + (f.username ? `&username=${encodeURIComponent(f.username)}` : '');
    try {
        const bd = await api('/api/analytics/breakdown' + q);
        must('costModelBody').innerHTML = rows(bd.by_model, false, false);
        must('costUserBody').innerHTML = rows(bd.by_user, false, true);
        must('costSessionBody').innerHTML = rows(bd.by_session.slice(0, 25), true, false);
        must('costKindBody').innerHTML = rows(bd.by_kind, false, false);
        if (bd.by_model.length) {
            doughnutChart('chModelMix', bd.by_model.slice(0, 8).map(r => r.key), bd.by_model.slice(0, 8).map(r => r.cost_usd), PALETTE);
        }
        must('costsMeta').textContent = `Updated ${when(bd.timestamp)} · top 50 each · click a user to filter`;
    }
    catch (e) {
        flash('err', e.message);
    }
}
//# sourceMappingURL=costs.js.map
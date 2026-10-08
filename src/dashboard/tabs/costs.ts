// Tab: Costs — ranked breakdowns (model / user / session / kind) + average tokens.
import { api, flash } from '../api.js';
import { ago, bytes, esc, must, nfmt, usd, usd6, when } from '../utils.js';
import type { AnalyticsBreakdown, BreakdownRow, AnalyticsSessions } from '../types.js';
import type { OverviewFilter } from './overview.js';
import { fetchAllSessions, mountExport } from './export.js';

let filterMode: 'all' | 'specific' = 'all';

/** Costs are exported at the same 6dp the table shows, so a sum still ties out. */
function round6(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
}

function modelRows(list: BreakdownRow[]): string {
  if (!list.length) return '<tr><td colspan="6" class="text-center text-muted py-3">No data in this window</td></tr>';
  return list.map(r => `<tr>
    <td class="mono">${esc(r.key)}</td>
    <td class="text-end">${nfmt(r.calls)}</td>
    <td class="text-end">${nfmt(r.input_tokens)}</td>
    <td class="text-end">${nfmt(r.output_tokens)}</td>
    <td class="text-end">${usd(r.cost_usd)}</td>
    <td class="text-end">${r.avg_latency_ms ? nfmt(r.avg_latency_ms) + ' ms' : '—'}</td>
  </tr>`).join('');
}

function userRows(list: BreakdownRow[], filterMode: 'all' | 'specific'): string {
  if (!list.length) return '<tr><td colspan="6" class="text-center text-muted py-3">No users in this window</td></tr>';
  return list.map((r, i) => `<tr>
    <td>${i < 10 && filterMode === 'all' ? `<a href="#" class="text-decoration-none" data-filteruser="${esc(r.key)}">${esc(r.key)}</a>` : esc(r.key)}</td>
    <td class="text-end">${nfmt(r.calls)}</td>
    <td class="text-end">${nfmt(r.total_tokens)}</td>
    <td class="text-end">${usd(r.cost_usd)}</td>
    <td class="text-end">${r.avg_latency_ms ? nfmt(r.avg_latency_ms) + ' ms' : '—'}</td>
    <td class="text-end">
      ${filterMode === 'all' && i < 10 ? `<button class="btn btn-sm btn-outline-primary btn-filter-user" data-filteruser="${esc(r.key)}" type="button">Filter</button>` : '—'}
    </td>
  </tr>`).join('');
}

function kindRows(list: BreakdownRow[]): string {
  if (!list.length) return '<tr><td colspan="6" class="text-center text-muted py-3">No data in this window</td></tr>';
  return list.map(r => `<tr>
    <td>${esc(r.key)}</td>
    <td class="text-end">${nfmt(r.calls)}</td>
    <td class="text-end">${nfmt(r.input_tokens)}</td>
    <td class="text-end">${nfmt(r.output_tokens)}</td>
    <td class="text-end">${usd(r.cost_usd)}</td>
    <td class="text-end">${r.avg_latency_ms ? nfmt(r.avg_latency_ms) + ' ms' : '—'}</td>
  </tr>`).join('');
}

function fileCell(s: AnalyticsSessions['sessions'][number]): string {
  if (!s.files_count) return '<span class="text-muted">0</span>';
  // Native title rather than a Bootstrap tooltip: it needs no initialisation, and
  // the list is short enough that a hover is enough to read.
  const title = s.files.map(f => `${f.name} (${f.type || 'file'}, ${bytes(f.size)})`).join('\n');
  const icon = s.files.some(f => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name))
    ? '<i class="bi bi-image me-1"></i>' : '<i class="bi bi-paperclip me-1"></i>';
  // A span, not a button: `data-session` would resolve to "conversation#N", which
  // the history endpoint does not know, so the click would 404 rather than open
  // anything. Deliberately NOT linked to the session drill-down.
  const approx = s.files_exact === false;
  return `<span class="badge text-bg-light border" title="${esc(title)}">${icon}${s.files_count}</span>`
    + (approx ? '<span class="text-warning ms-1" title="Counted from upload timing, not recorded from what the model read">~</span>' : '');
}

function sessionRows(list: AnalyticsSessions['sessions']): string {
  if (!list.length) return '<tr><td colspan="14" class="text-center text-muted py-3">No sessions in this window</td></tr>';
  return list.map(s => `<tr>
    <td class="mono small">${esc(s.session_id)}</td>
    <td>${esc(s.user)}</td>
    <td><span class="badge bg-light text-dark border">${esc(s.mode)}</span></td>
    <td><span class="badge ${s.status === 'ended' ? 'bg-secondary' : 'bg-success'}">${esc(s.status)}</span></td>
    <td class="text-end">${nfmt(s.user_messages)}</td>
    <td class="text-end">${nfmt(s.assistant_messages)}</td>
    <td class="text-end">${fileCell(s)}</td>
    <td class="text-end">${nfmt(s.input_tokens)}</td>
    <td class="text-end">${nfmt(s.output_tokens)}</td>
    <td class="text-end">${usd6(s.input_cost_usd)}</td>
    <td class="text-end">${usd6(s.output_cost_usd)}</td>
    <td class="text-end fw-semibold">${usd6(s.cost_usd)}</td>
    <td class="small text-nowrap">${when(s.created_at)}</td>
    <td class="small text-nowrap">${s.status === 'ended' ? when(s.last_activity) : `<span class="text-muted">${ago(s.last_activity)}</span>`}</td>
  </tr>`).join('');
}

export async function renderCosts(f: OverviewFilter & { filterMode?: 'all' | 'specific'; sessionLimit?: number | 'all' }): Promise<void> {
  const sessionLimit = f.sessionLimit ?? 50;
  filterMode = f.filterMode ?? 'all';
  const q = `?days=${f.days}` + (f.username ? `&username=${encodeURIComponent(f.username)}` : '');
  try {
    const bd = await api<AnalyticsBreakdown>('/api/analytics/breakdown' + q);
    must('costModelBody').innerHTML = modelRows(bd.by_model);
    must('costKindBody').innerHTML = kindRows(bd.by_kind);
    must('costUserBody').innerHTML = userRows(bd.by_user, filterMode);
    mountExport(must('usersExportHost'), {
      label: 'Export',
      filename: 'ami-cost-by-user',
      scopeNote: `${f.days}d-${f.username || 'all-users'}`,
      columns: [
        { header: 'User', value: (r: BreakdownRow) => r.key },
        { header: 'Calls', value: (r: BreakdownRow) => r.calls },
        { header: 'Input Tokens', value: (r: BreakdownRow) => r.input_tokens },
        { header: 'Output Tokens', value: (r: BreakdownRow) => r.output_tokens },
        { header: 'Tokens', value: (r: BreakdownRow) => r.total_tokens },
        { header: 'Ledger Cost', value: (r: BreakdownRow) => round6(r.cost_usd) },
        { header: 'Avg Latency ms', value: (r: BreakdownRow) => r.avg_latency_ms ?? '' },
      ],
      // No "all" option: this table is never truncated, so there is nothing to
      // fetch beyond what is rendered.
      current: bd.by_user
    });

    // Fetch sessions with limit and username filter
    const sessionsQ = `?limit=${sessionLimit === 'all' ? 'all' : sessionLimit}${f.username ? `&username=${encodeURIComponent(f.username)}` : ''}`;
    const sessions = await api<AnalyticsSessions>(`/api/analytics/sessions${sessionsQ}`);
    must('costSessionBody').innerHTML = sessionRows(sessions.sessions);
    must('costSessionCount').textContent =
      `${nfmt(sessions.count)} session${sessions.count === 1 ? '' : 's'}`;

    // Exported from the API payload, never scraped back out of the DOM. The
    // rendered row is abbreviated (dates localised, costs rounded), so scraping it
    // would produce a file that does not reconcile with the numbers on screen.
    const sessionColumns = [
      { header: 'Session', value: (s: AnalyticsSessions['sessions'][number]) => s.session_id },
      { header: 'User', value: (s: AnalyticsSessions['sessions'][number]) => s.user },
      { header: 'Mode', value: (s: AnalyticsSessions['sessions'][number]) => s.mode },
      { header: 'State', value: (s: AnalyticsSessions['sessions'][number]) => s.status },
      { header: 'Msgs In', value: (s: AnalyticsSessions['sessions'][number]) => s.user_messages },
      { header: 'Msgs Out', value: (s: AnalyticsSessions['sessions'][number]) => s.assistant_messages },
      { header: 'Files', value: (s: AnalyticsSessions['sessions'][number]) => s.files_count },
      { header: 'Input Tokens', value: (s: AnalyticsSessions['sessions'][number]) => s.input_tokens },
      { header: 'Output Tokens', value: (s: AnalyticsSessions['sessions'][number]) => s.output_tokens },
      { header: 'IT Cost', value: (s: AnalyticsSessions['sessions'][number]) => round6(s.input_cost_usd) },
      { header: 'OT Cost', value: (s: AnalyticsSessions['sessions'][number]) => round6(s.output_cost_usd) },
      { header: 'Total Cost', value: (s: AnalyticsSessions['sessions'][number]) => round6(s.cost_usd) },
      { header: 'Start', value: (s: AnalyticsSessions['sessions'][number]) => s.created_at || '' },
      { header: 'End', value: (s: AnalyticsSessions['sessions'][number]) => s.last_activity || '' },
    ];
    const rateNote = `${sessions.rates.input_per_million}-${sessions.rates.output_per_million}per1M`;
    mountExport(must('sessionExportHost'), {
      label: 'Export',
      filename: 'ami-sessions',
      scopeNote: f.username || 'all-users',
      columns: sessionColumns,
      current: sessions.sessions,
      fetchAll: () => fetchAllSessions(f)
    });
    // The rate lives in the filename because a cost column without its rate is
    // not interpretable months later.
    must('sessionExportHost').title =
      `Costs priced at $${sessions.rates.input_per_million}/1M input and ` +
      `$${sessions.rates.output_per_million}/1M output (${rateNote}).`;

    // The rates are echoed back so the table header can state what it priced at,
// instead of leaving the reader to assume the provider's real rates.
must('costRateBadge').textContent =
      `$${sessions.rates.input_per_million}/1M in · $${sessions.rates.output_per_million}/1M out`
      + (sessions.rates.source === 'custom' ? ' (custom)' : '');
    must('costRateBadge').title = 'Token rates used for IT/OT Cost. Edit from the Live tab or Ctrl+Shift+R.';

    const chip = must('costFilterChip');
    chip.classList.toggle('d-none', !f.username);
    chip.classList.toggle('d-inline-flex', !!f.username);
    if (f.username) must('costFilterChipText').textContent = f.username;

    // Calculate average input/output tokens across all models
    if (bd.by_model.length) {
      const totalInput = bd.by_model.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
      const totalOutput = bd.by_model.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
      const avgInput = bd.by_model.length > 0 ? Math.round(totalInput / bd.by_model.length) : 0;
      const avgOutput = bd.by_model.length > 0 ? Math.round(totalOutput / bd.by_model.length) : 0;

      must('statCards').innerHTML = `
        <div class="col-6 col-md-4 col-xl-3">
          <div class="card metric-card border-0 shadow-sm rounded-3 h-100">
            <div class="card-body p-3 text-center">
              <div class="small text-muted">Avg Input Tokens</div>
              <div class="h4 fw-bold text-ami">${nfmt(avgInput)}</div>
              <div class="small text-muted">per model</div>
            </div>
          </div>
        </div>
        <div class="col-6 col-md-4 col-xl-3">
          <div class="card metric-card border-0 shadow-sm rounded-3 h-100">
            <div class="card-body p-3 text-center">
              <div class="small text-muted">Avg Output Tokens</div>
              <div class="h4 fw-bold text-success">${nfmt(avgOutput)}</div>
              <div class="small text-muted">per model</div>
            </div>
          </div>
        </div>
      `;
    } else {
      must('statCards').innerHTML = '<div class="col-12 text-center text-muted py-4">No model data in this window</div>';
    }

    must('costsMeta').textContent = `Updated ${when(bd.timestamp)} · top 50 each · limit: ${sessionLimit === 'all' ? 'All' : sessionLimit}${f.username ? ` · user: ${f.username}` : ''}`;
  } catch (e) {
    flash('err', (e as Error).message);
  }
}

export { filterMode };
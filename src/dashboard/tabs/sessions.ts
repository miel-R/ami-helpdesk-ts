// Tab: Sessions - enriched conversation list with cost + CSV/JSON export.
import { api, flash } from '../api.js';
import { ago, esc, must, nfmt, usd } from '../utils.js';
import type { AnalyticsSessions, AnalyticsSessionRow } from '../types.js';
import { fetchAllSessions, mountExport, sessionColumns } from './export.js';

function statusBadge(s: string, lastActivity?: string | null): string {
  if (s === 'escalated') return '<span class="badge bg-warning text-dark">escalated</span>';
  if (s === 'ended') {
    if (lastActivity) {
      const lastActive = new Date(lastActivity).getTime();
      const now = Date.now();
      const diffMs = now - lastActive;
      const diffMins = diffMs / 60000;
      if (diffMins < 15) return '<span class="badge bg-success">active</span>';
      if (diffMins < 60) return '<span class="badge bg-info text-dark">idle</span>';
    }
    return '<span class="badge bg-secondary">ended</span>';
  }
  return '<span class="badge bg-success">active</span>';
}

export async function renderSessions(limit = 100): Promise<void> {
  const host = must('convBody');
  // Nine columns. The placeholder used to say colspan="11" against a ten-column
  // table, which was harmless only because the surplus width was never visible -
  // an empty-state row spanning more columns than exist is exactly the kind of
  // thing that goes on hiding a column that was genuinely added later.
  host.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">Loading sessions...</td></tr>';
  try {
    // This tab shows every session in the window; it does not apply the top-bar
    // user filter. The export is scoped from the same filter object the fetch
    // uses, so the filename can never claim a narrower scope than the table it
    // was taken from.
    const f: { username: string | null } = { username: null };
    const data = await api<AnalyticsSessions>('/api/analytics/sessions?limit=' + limit);
    must('sessionsMeta').textContent = data.count + ' session(s)';
    host.innerHTML = data.sessions.map((s: AnalyticsSessionRow) => '<tr>' +
      '<td class="mono small">' + esc(s.session_id.slice(0, 12)) + '...</td>' +
      '<td>' + esc(s.user) + '</td>' +
      '<td><span class="badge bg-light text-dark border">' + esc(s.mode) + '</span></td>' +
      '<td>' + statusBadge(s.status, s.last_activity) + '</td>' +
      '<td class="text-end">' + nfmt(s.messages) + '</td>' +
      '<td class="text-end">' + nfmt(s.ai_calls) + '</td>' +
      '<td class="text-end">' + nfmt(s.total_tokens) + '</td>' +
      '<td class="text-end">' + usd(s.cost_usd) + '</td>' +
      '<td class="text-end small">' + (s.last_activity ? esc(ago(s.last_activity)) : '-') + '</td>' +
    '</tr>').join('') || '<tr><td colspan="9" class="text-center text-muted py-3">No sessions</td></tr>';

    // Same columns as the Costs tab's per-session table, from the same module, so
    // the two exports of "the session data" cannot drift apart.
    mountExport(must('convExportHost'), {
      label: 'Export',
      filename: 'ami-sessions',
      scopeNote: f.username || 'all-users',
      columns: sessionColumns,
      current: data.sessions,
      fetchAll: () => fetchAllSessions(f),
    });
  } catch (e: unknown) {
    host.innerHTML = '<tr><td colspan="9" class="text-center text-danger py-3">Failed to load sessions</td></tr>';
    flash('err', (e as Error).message);
  }
}
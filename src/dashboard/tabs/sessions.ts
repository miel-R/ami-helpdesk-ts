// Tab: Sessions - enriched conversation list with cost + drill-down.
import { api, flash } from '../api.js';
import { ago, esc, must, nfmt, usd } from '../utils.js';
import type { AnalyticsSessions, AnalyticsSessionRow } from '../types.js';

function statusBadge(s: string, lastActivity?: string | null): string {
  if (s === 'escalated') return '<span class=\"badge bg-warning text-dark\">escalated</span>';
  if (s === 'ended') {
    if (lastActivity) {
      const lastActive = new Date(lastActivity).getTime();
      const now = Date.now();
      const diffMs = now - lastActive;
      const diffMins = diffMs / 60000;
      if (diffMins < 15) return '<span class=\"badge bg-success\">active</span>';
      if (diffMins < 60) return '<span class=\"badge bg-info text-dark\">idle</span>';
    }
    return '<span class=\"badge bg-secondary\">ended</span>';
  }
  return '<span class=\"badge bg-success\">active</span>';
}

export async function renderSessions(limit = 100): Promise<void> {
  const host = must('convBody');
  host.innerHTML = '<tr><td colspan=\"11\" class=\"text-center text-muted py-3\">Loading sessions...</td></tr>';
  try {
    const data = await api<AnalyticsSessions>('/api/analytics/sessions?limit=' + limit);
    must('sessionsMeta').textContent = data.count + ' session(s)';
    host.innerHTML = data.sessions.map((s: AnalyticsSessionRow) => '<tr>' +
      '<td class=\"mono small\">' + esc(s.session_id.slice(0, 12)) + '...</td>' +
      '<td>' + esc(s.user) + '</td>' +
      '<td><span class=\"badge bg-light text-dark border\">' + esc(s.mode) + '</span></td>' +
      '<td>' + statusBadge(s.status, s.last_activity) + '</td>' +
      '<td class=\"text-end\">' + nfmt(s.messages) + '</td>' +
      '<td class=\"text-end\">' + nfmt(s.ai_calls) + '</td>' +
      '<td class=\"text-end\">' + nfmt(s.total_tokens) + '</td>' +
      '<td class=\"text-end\">' + usd(s.cost_usd) + '</td>' +
      '<td class=\"text-end small\">' + (s.last_activity ? esc(ago(s.last_activity)) : '-') + '</td>' +
      '<td class=\"text-end\"><button class=\"btn btn-sm btn-outline-secondary\" data-session=\"' + esc(s.session_id) + '\"><i class=\"bi bi-eye\"></i></button></td>' +
    '</tr>').join('') || '<tr><td colspan=\"11\" class=\"text-center text-muted py-3\">No sessions</td></tr>';
  } catch (e: unknown) {
    host.innerHTML = '<tr><td colspan=\"11\" class=\"text-center text-danger py-3\">Failed to load sessions</td></tr>';
    flash('err', (e as Error).message);
  }
}

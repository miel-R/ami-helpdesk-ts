// Tab: Users — per-user rollup table with quota bars + manage actions.
import { api, flash } from '../api.js';
import { ago, esc, must, nfmt, usd } from '../utils.js';
import type { AnalyticsUsers } from '../types.js';

export function quotaBar(used: number, limit: number | null): string {
  if (limit === null) return '<span class="badge bg-dark">unlimited</span>';
  if (!limit) return '<span class="badge bg-secondary">0 cap</span>';
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const cls = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success';
  return `<div class="progress" style="height:8px;min-width:90px" title="${used}/${limit}">
    <div class="progress-bar ${cls}" style="width:${pct}%"></div></div>
    <small class="text-muted">${used}/${limit}</small>`;
}

export async function renderUsers(days: number): Promise<void> {
  const host = must('userRows');
  host.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">Loading users…</td></tr>';
  try {
    const data = await api<AnalyticsUsers>('/api/analytics/users?days=' + days);
    must('usersMeta').textContent = `${data.count} user(s) · last ${data.days}d ledger`;
    host.innerHTML = data.users.map(u => `<tr>
      <td><strong>${esc(u.display_name)}</strong><br><small class="mono text-muted">${esc(u.username)}</small></td>
      <td>${esc(u.department || '—')}</td>
      <td class="text-end">${nfmt(u.calls)}</td>
      <td class="text-end">${nfmt(u.total_tokens)}</td>
      <td class="text-end">${usd(u.cost_usd)}</td>
      <td>${quotaBar(u.requests_today, u.requests_limit)}</td>
      <td class="text-end small">${u.last_active ? esc(ago(u.last_active)) : '—'}</td>
      <td class="text-end">
        <button class="btn btn-sm btn-outline-secondary" data-detail="${esc(u.username)}" title="Details"><i class="bi bi-eye"></i></button>
        <button class="btn btn-sm btn-outline-primary" data-edit="${esc(u.username)}" title="Edit"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-info" data-filteruser="${esc(u.username)}" title="Filter costs"><i class="bi bi-funnel"></i></button>
      </td>
    </tr>`).join('') || '<tr><td colspan="9" class="text-center text-muted py-3">No users yet</td></tr>';
  } catch (e) {
    host.innerHTML = '<tr><td colspan="9" class="text-center text-danger py-3">Failed to load users</td></tr>';
    flash('err', (e as Error).message);
  }
}

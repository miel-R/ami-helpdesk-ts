// Tab: Users — per-user rollup table with quota bars + manage actions.
import { api, flash } from '../api.js';
import { ago, esc, must, nfmt, usd } from '../utils.js';
export function quotaBar(used, limit) {
    if (limit === null)
        return '<span class="badge bg-dark">unlimited</span>';
    if (!limit)
        return '<span class="badge bg-secondary">0 cap</span>';
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const cls = pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-success';
    return `<div class="progress" style="height:8px;min-width:90px" title="${used}/${limit}">
    <div class="progress-bar ${cls}" style="width:${pct}%"></div></div>
    <small class="text-muted">${used}/${limit}</small>`;
}
/**
 * The MIS helpdesk role as a badge.
 *
 * This is MIS's own role, read live from `scrf_user.user_role` — not the
 * chatbot's role. The distinction matters: the chatbot collapses MIS's three
 * roles into two on purpose (Approver gets nothing extra, because approving a
 * ticket is a different permission from operating the dashboard), so the
 * chatbot role is the same value for two of the three, and a column of them all
 * reading "user" was accurate but useless. The chatbot role still decides
 * permissions; it just no longer pretends to describe the helpdesk.
 */
function roleBadge(role) {
    const r = (role || '').trim().toLowerCase();
    if (r === 'admin')
        return '<span class="badge bg-ami-subtle text-ami">Admin</span>';
    if (r === 'approver')
        return '<span class="badge bg-info text-dark">Approver</span>';
    if (r === 'user')
        return '<span class="badge bg-secondary">User</span>';
    // Never swallow a role the UI does not recognise: an unexpected value is more
    // useful shown verbatim than collapsed into "User".
    return esc(role || '—');
}
/**
 * One cell for the Role column: the badge, plus a tooltip saying where it came
 * from. MIS not answering is not the same as someone being a User, so the two
 * cases are labelled differently instead of both rendering as "User".
 *
 * The cell's text content is still the plain role word, so the column keeps
 * sorting correctly through the shared table sorter.
 */
function roleCell(u) {
    const fromMis = !!(u.mis_role || '').trim();
    const badge = roleBadge(fromMis ? u.mis_role : u.role);
    const title = fromMis
        ? 'Helpdesk role, read from MIS. Permissions follow the chatbot role.'
        : 'MIS did not report a role for this account, so this is the chatbot role (used when MIS is unreachable).';
    return `<td title="${esc(title)}">${badge}</td>`;
}
export async function renderUsers(days) {
    const host = must('userRows');
    host.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">Loading users…</td></tr>';
    try {
        const data = await api('/api/analytics/users?days=' + days);
        must('usersMeta').textContent = `${data.count} user(s) · last ${data.days}d ledger`;
        host.innerHTML = data.users.map(u => `<tr>
      <td><strong>${esc(u.display_name)}</strong><br><small class="mono text-muted">${esc(u.username)}</small></td>
      ${roleCell(u)}
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
    }
    catch (e) {
        host.innerHTML = '<tr><td colspan="9" class="text-center text-danger py-3">Failed to load users</td></tr>';
        flash('err', e.message);
    }
}
//# sourceMappingURL=users.js.map
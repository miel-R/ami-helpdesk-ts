// User management: create / edit / detail modal + delete.
// Isolated module: user CRUD never shares code with the analytics tabs.
import { api, flash } from '../api.js';
import { bytes, esc, nfmt, usd, when } from '../utils.js';
import { closeModal, openModal } from '../modal.js';
export async function openUserEditor(username) {
    try {
        const data = await api('/api/admin/users?days=1');
        const u = (data.users || []).find(x => String(x.username) === username);
        if (!u) {
            flash('err', `User "${username}" not found`);
            return;
        }
        openModal(`Edit ${username}`, `<form id="editUserForm" class="vstack gap-3">
      <div><label class="form-label small fw-semibold">Role</label>
        <select id="euRole" class="form-select"><option value="user">user</option><option value="admin">admin</option></select></div>
      <div><label class="form-label small fw-semibold">Requests / day (blank = inherit)</label>
        <input id="euReq" type="number" min="0" class="form-control" placeholder="inherit"></div>
      <div><label class="form-label small fw-semibold">Max upload MB (blank = inherit)</label>
        <input id="euUp" type="number" min="0" step="0.5" class="form-control" placeholder="inherit"></div>
      <div><label class="form-label small fw-semibold">Enabled</label>
        <select id="euEnabled" class="form-select"><option value="1">enabled</option><option value="0">disabled</option></select></div>
      <div><label class="form-label small fw-semibold">Note</label>
        <textarea id="euNote" class="form-control" rows="2"></textarea></div>
      <div class="d-flex gap-2"><button class="btn btn-ami" type="submit">Save</button>
        <button class="btn btn-outline-secondary" type="button" id="euCancel">Cancel</button></div>
    </form>`);
        document.getElementById('euRole').value = String(u.role || 'user');
        document.getElementById('euEnabled').value = u.enabled === false ? '0' : '1';
        document.getElementById('euNote').value = String(u.note || '');
        document.getElementById('euCancel')?.addEventListener('click', closeModal);
        document.getElementById('editUserForm')?.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const req = document.getElementById('euReq').value.trim();
            const upMb = document.getElementById('euUp').value.trim();
            const body = {
                role: document.getElementById('euRole').value,
                enabled: document.getElementById('euEnabled').value === '1',
                requests_per_day: req === '' ? null : Number(req),
                max_upload_bytes: upMb === '' ? null : Math.round(Number(upMb) * 1048576),
                note: document.getElementById('euNote').value,
            };
            try {
                await api(`/api/admin/users/${encodeURIComponent(username)}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                });
                closeModal();
                flash('ok', `User ${username} updated.`);
                document.dispatchEvent(new CustomEvent('ami:users-changed'));
            }
            catch (e) {
                flash('err', e.message);
            }
        });
    }
    catch (e) {
        flash('err', e.message);
    }
}
export async function openUserDetail(username) {
    try {
        const [cfg, ledger] = await Promise.all([
            api('/api/admin/config'),
            api(`/api/usage/messages?username=${encodeURIComponent(username)}&limit=50`),
        ]);
        const msgs = ledger.messages || [];
        const rows = msgs.map(m => `<tr><td class="small">${esc(when(String(m.created_at || '')))}</td>
      <td class="mono small">${esc(String(m.model || m.provider || ''))}</td>
      <td class="text-end">${nfmt(m.total_tokens)}</td>
      <td class="text-end">${usd(m.cost_usd)}</td></tr>`).join('');
        openModal(`User: ${username}`, `
      <p class="small text-muted">Defaults: ${cfg.defaults.requests_per_day} req/day · ${bytes(cfg.defaults.max_upload_bytes)} upload cap</p>
      <h6 class="fw-bold">Recent AI calls (${msgs.length})</h6>
      <div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>When</th><th>Model</th><th class="text-end">Tokens</th><th class="text-end">Cost</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="text-muted">No calls</td></tr>'}</tbody>
      </table></div>`);
    }
    catch (e) {
        flash('err', e.message);
    }
}
export function wireUserForm() {
    document.getElementById('newUserForm')?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const upMb = document.getElementById('nuUp').value.trim();
        const reqVal = document.getElementById('nuReq').value.trim();
        const body = {
            username: document.getElementById('nuName').value.trim(),
            department: document.getElementById('nuDept').value.trim(),
            role: document.getElementById('nuRole').value,
            requests_per_day: reqVal === '' ? null : Number(reqVal),
            max_upload_bytes: upMb === '' ? null : Math.round(Number(upMb) * 1048576),
        };
        try {
            await api('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            document.getElementById('newUserForm').reset();
            flash('ok', `User ${body.username} created.`);
            document.dispatchEvent(new CustomEvent('ami:users-changed'));
        }
        catch (e) {
            flash('err', e.message);
        }
    });
}
//# sourceMappingURL=user-admin.js.map
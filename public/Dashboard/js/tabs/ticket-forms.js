// Tab: Ticket Forms — which ticket types the chatbot fills in itself.
//
// A type can be switched off, and then the chat hands the user a link to the real
// MIS form instead of opening one. That is the point: the chatbot's copy of a
// form is only as good as the last time somebody synced it, and MIS is free to
// change theirs at any time. When the two disagree, a link is honest and a stale
// form is not.
//
// The switch applies to everyone, admins included. It is not a permissions
// question — it records that the chatbot is not authorised to file that kind of
// ticket — and an admin asking for one should land in the same place.
import { api, flash } from '../api.js';
import { esc, must, when } from '../utils.js';
let rows = [];
/** Rows being edited, so a failed save does not silently drop the change. */
const draft = {};
let linksOnly = false;
function rowHtml(r) {
    const d = draft[r.ticket_type];
    const enabled = d ? d.enabled : r.enabled;
    const url = d ? d.external_url : (r.external_url || '');
    // The warning is on the row rather than on save: "off with no link" is a state
    // an admin can create by clearing the field, and it should be visible while they
    // are still looking at it rather than after a round trip.
    const orphan = !enabled && !url.trim();
    const warnings = [];
    if (enabled && url.trim()) {
        warnings.push('The link is saved but ignored while this type is enabled.');
    }
    if (orphan) {
        warnings.push('Off with no link means nobody can file this ticket at all — the chat will say so.');
    }
    // In links-only mode nothing opens a form, so a type with no link becomes a dead
    // end. Said here rather than only on save, because the mode can be flipped
    // without touching this row at all.
    const noLinkAtAll = linksOnly && !url.trim();
    if (noLinkAtAll) {
        warnings.push('Links only is on and this type has no link, so it will not be offered.');
    }
    return `<tr data-type="${esc(r.ticket_type)}">
    <td><strong>${esc(r.label)}</strong><div class="small text-muted">${esc(r.ticket_type)}</div></td>
    <td>
      <div class="form-check form-switch mb-0">
        <input class="form-check-input" type="checkbox" role="switch" data-field="enabled" id="tgl-${esc(r.ticket_type)}"
          ${enabled ? 'checked' : ''} aria-label="Chatbot fills in ${esc(r.label)}">
        <label class="form-check-label small" for="tgl-${esc(r.ticket_type)}">${enabled ? 'Enabled' : 'Off'}</label>
      </div>
    </td>
    <td>
      <input class="form-control form-control-sm" type="url" data-field="external_url"
        placeholder="https://mis.example/index.php?option=..."
        value="${esc(url)}" aria-label="External link for ${esc(r.label)}">
      ${warnings.length ? `<div class="small text-warning mt-1">${warnings.map(esc).join('<br>')}</div>` : ''}
    </td>
    <td class="text-end">
      <button type="button" class="btn btn-sm btn-ami" data-action="save">Save</button>
    </td>
  </tr>`;
}
function paint() {
    must('ticketFormBody').innerHTML = rows.length
        ? rows.map(rowHtml).join('')
        : '<tr><td colspan="4" class="text-center text-muted py-3">No ticket types reported by the server.</td></tr>';
}
function warn(text) {
    const el = must('ticketFormsWarn');
    el.textContent = text;
    el.classList.toggle('d-none', !text);
}
export async function renderTicketForms() {
    try {
        const res = await api('/api/admin/ticket-modals');
        linksOnly = res.links_only === true;
        document.getElementById('linksOnlyToggle').checked = linksOnly;
        // A type that was mid-edit when the tab was re-entered keeps the edit rather
        // than snapping back to the saved value under the admin's cursor.
        rows = res.ticket_modals || [];
        for (const r of rows) {
            if (!draft[r.ticket_type]) {
                draft[r.ticket_type] = { enabled: r.enabled, external_url: r.external_url || '' };
            }
            else {
                draft[r.ticket_type].enabled = r.enabled;
                if (!draft[r.ticket_type].external_url)
                    draft[r.ticket_type].external_url = r.external_url || '';
            }
        }
        paint();
        must('settingsMeta').textContent = `Updated ${when(res.timestamp)}`;
        warn('');
    }
    catch (e) {
        flash('err', e.message);
    }
}
async function save(type) {
    const d = draft[type];
    if (!d)
        return;
    const url = d.external_url.trim();
    try {
        await api(`/api/admin/ticket-modals/${encodeURIComponent(type)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: d.enabled, external_url: url || null })
        });
        // The cache on the server is dropped by the save, so the next chat turn sees
        // this. Said plainly rather than implying the whole app needs restarting.
        flash('ok', `Saved. New chats pick this up within 30 seconds.`);
        await renderTicketForms();
    }
    catch (e) {
        flash('err', e.message);
    }
}
/** One-time wiring, called from main's boot. */
export function wireTicketForms() {
    const body = document.getElementById('ticketFormBody');
    if (!body)
        return;
    document.getElementById('linksOnlySave')?.addEventListener('click', async () => {
        const on = document.getElementById('linksOnlyToggle')?.checked === true;
        try {
            await api('/api/admin/ticket-modals/links-only', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: on })
            });
            flash('ok', on
                ? 'Links only on. No type opens a form from now on.'
                : 'Links only off. Enabled types open the in-chat form again.');
            await renderTicketForms();
        }
        catch (e) {
            flash('err', e.message);
        }
    });
    body.addEventListener('change', ev => {
        const t = ev.target;
        if (!t)
            return;
        const tr = t.closest('tr');
        const type = tr?.dataset.type;
        if (!type || !draft[type])
            return;
        const field = t.dataset.field;
        if (field === 'enabled') {
            draft[type].enabled = t.checked;
            paint();
        }
    });
    body.addEventListener('input', ev => {
        const t = ev.target;
        if (!t || t.dataset.field !== 'external_url')
            return;
        const type = t.closest('tr')?.dataset.type;
        if (!type || !draft[type])
            return;
        draft[type].external_url = t.value;
    });
    body.addEventListener('click', ev => {
        const t = ev.target;
        if (!t || typeof t.closest !== 'function')
            return;
        const btn = t.closest('[data-action="save"]');
        if (!btn)
            return;
        const type = btn.closest('tr')?.dataset.type;
        if (!type)
            return;
        ev.preventDefault();
        void save(type);
    });
}
//# sourceMappingURL=ticket-forms.js.map
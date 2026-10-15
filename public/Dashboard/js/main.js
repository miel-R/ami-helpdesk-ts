// Dashboard entry (part 1): imports, tab router, guarded refresh.
import { api, clearKey, flash, getKey, setKey } from './api.js';
import { esc, must } from './utils.js';
import { renderOverview } from './tabs/overview.js';
import { renderTrends } from './tabs/trends.js';
import { renderCosts } from './tabs/costs.js';
import { renderUsers } from './tabs/users.js';
import { renderSessions } from './tabs/sessions.js';
import { renderRealtime } from './tabs/realtime.js';
import { renderLogs, wireLogFilters } from './tabs/inspect.js';
import { renderTicketForms, wireTicketForms } from './tabs/ticket-forms.js';
import { wireRateEditor } from './tabs/rates.js';
import { openUserDetail, openUserEditor, wireUserForm } from './tabs/user-admin.js';
import { wireSortableTables, resortTables } from './sortable.js';
import { applyStoredTheme, toggleTheme } from './theme.js';
let activeTab = 'overview';
export function currentFilter() {
    const days = Number(document.getElementById('usageDays')?.value || 1);
    const user = document.getElementById('usageUser')?.value.trim() || null;
    return {
        days: Number.isFinite(days) ? days : 1,
        username: user || null,
        filterMode,
        sessionLimit
    };
}
export async function safe(name, fn) {
    try {
        await fn();
    }
    catch (e) {
        console.error(`[dashboard] tab "${name}" failed:`, e);
        flash('err', `${name}: ${e.message}`);
    }
}
export async function refreshAll() {
    const f = currentFilter();
    const stamp = must('lastUpd');
    stamp.hidden = false;
    stamp.textContent = 'updating…';
    await safe('overview', () => renderOverview(f));
    if (activeTab === 'trends')
        await safe('trends', () => renderTrends(f));
    if (activeTab === 'cost')
        await safe('costs', () => renderCosts(f));
    if (activeTab === 'users')
        await safe('users', () => renderUsers(f.days));
    if (activeTab === 'conv')
        await safe('sessions', () => renderSessions(100));
    if (activeTab === 'live')
        await safe('live', () => renderRealtime());
    if (activeTab === 'settings')
        await safe('ticket forms', () => renderTicketForms());
    if (activeTab === 'logs')
        await safe('logs', () => renderLogs());
    // A re-render replaces tbody contents, so any header sort the admin chose would
    // otherwise be undone by the next auto-refresh.
    resortTables();
    stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
}
/** Tab ids in the order they appear in the tab strip, for arrow-key movement. */
const TAB_ORDER = ['overview', 'trends', 'cost', 'users', 'conv', 'live', 'settings', 'logs'];
export function switchTab(id, focus = false) {
    activeTab = id;
    document.querySelectorAll('[data-tab]').forEach(b => {
        const btn = b;
        const on = btn.dataset.tab === id;
        btn.classList.toggle('active', on);
        // role="tablist" promises this state; without it a screen reader announces
        // every tab as equally selected.
        btn.setAttribute('aria-selected', String(on));
        // Roving tabindex: only the selected tab is in the tab order, so Tab moves
        // out of the strip instead of walking through all eight.
        btn.setAttribute('tabindex', on ? '0' : '-1');
    });
    document.querySelectorAll('[data-panel]').forEach(p => {
        const panel = p;
        panel.hidden = panel.dataset.panel !== id;
        if (!panel.hidden)
            panel.setAttribute('tabindex', '0');
    });
    if (focus) {
        const btn = document.querySelector(`[data-tab="${id}"]`);
        btn?.focus();
    }
    void refreshAll();
}
/**
 * Left/Right/Home/End within the tab strip. role="tablist" implies arrow-key
 * navigation; without it the strip is a trap for keyboard users, because every
 * button is a separate Tab stop and there is no way to move along the strip.
 */
function wireTabKeys() {
    document.querySelectorAll('[data-tab]').forEach(b => {
        b.addEventListener('keydown', e => {
            const ev = e;
            const here = b.dataset.tab;
            const at = TAB_ORDER.indexOf(here);
            let next = null;
            if (ev.key === 'ArrowRight')
                next = TAB_ORDER[(at + 1) % TAB_ORDER.length];
            else if (ev.key === 'ArrowLeft')
                next = TAB_ORDER[(at - 1 + TAB_ORDER.length) % TAB_ORDER.length];
            else if (ev.key === 'Home')
                next = TAB_ORDER[0];
            else if (ev.key === 'End')
                next = TAB_ORDER[TAB_ORDER.length - 1];
            if (!next)
                return;
            ev.preventDefault();
            switchTab(next, true);
        });
    });
}
function showLogin() {
    must('login').hidden = false;
    must('app').hidden = true;
    must('loginKey').value = getKey();
    setTimeout(() => must('loginKey').focus(), 30);
}
function showApp() {
    must('login').hidden = true;
    must('app').hidden = false;
}
function signOut(msg) {
    clearKey();
    showLogin();
    if (msg) {
        const e = must('loginErr');
        e.textContent = msg;
        e.hidden = false;
    }
}
function wireAuth() {
    document.addEventListener('ami:unauthorized', () => signOut('Your admin key was rejected.'));
    must('loginForm').addEventListener('submit', ev => {
        ev.preventDefault();
        setKey(must('loginKey').value);
        must('loginErr').hidden = true;
        api('/api/admin/config')
            .then(() => { showApp(); return refreshAll(); })
            .catch(() => signOut('Could not verify that key.'));
    });
    must('logoutBtn').addEventListener('click', () => signOut());
}
// Costs tab filter state and handlers
let filterMode = 'all';
let sessionLimit = 50;
function costSearchInput() {
    return document.getElementById('costUserSearch');
}
/** Keeps the global user filter, the Costs search box and the mode select in sync. */
function syncUserFilterUI(user, mode) {
    const globalUser = document.getElementById('usageUser');
    const search = costSearchInput();
    const modeSelect = document.getElementById('usageFilterMode');
    const val = user || '';
    if (globalUser)
        globalUser.value = val;
    if (search) {
        search.value = val;
        search.style.display = mode === 'specific' ? '' : 'none';
    }
    if (modeSelect)
        modeSelect.value = mode;
}
/** Single entry point for applying a user filter from any UI affordance. */
function setUserFilter(user) {
    const val = (user || '').trim();
    filterMode = val ? 'specific' : 'all';
    syncUserFilterUI(val || null, filterMode);
    void refreshAll();
}
async function suggestUsers(term) {
    const dl = document.getElementById('costUserOptions');
    if (!dl)
        return;
    try {
        const res = await api(`/api/admin/users/search?q=${encodeURIComponent(term)}&limit=10`);
        dl.innerHTML = res.users.map(u => `<option value="${esc(u.username)}"></option>`).join('');
    }
    catch {
        dl.innerHTML = '';
    }
}
function wireCostFilters() {
    const modeSelect = document.getElementById('usageFilterMode');
    const search = costSearchInput();
    const limitSelect = document.getElementById('sessionLimit');
    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            if (modeSelect.value === 'specific') {
                filterMode = 'specific';
                const existing = document.getElementById('usageUser')?.value.trim() || '';
                syncUserFilterUI(existing || null, 'specific');
                search?.focus();
            }
            else {
                setUserFilter(null);
                return;
            }
            void refreshAll();
        });
    }
    if (search) {
        let timer;
        search.addEventListener('input', () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => void suggestUsers(search.value.trim()), 200);
        });
        search.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                setUserFilter(search.value);
            }
        });
    }
    document.getElementById('costUserApply')?.addEventListener('click', () => {
        setUserFilter(costSearchInput()?.value || null);
    });
    document.getElementById('costFilterClear')?.addEventListener('click', () => setUserFilter(null));
    if (limitSelect) {
        limitSelect.addEventListener('change', () => {
            sessionLimit = limitSelect.value === 'all' ? 'all' : parseInt(limitSelect.value, 10);
            void refreshAll();
        });
    }
    // Typing in the global top-bar user field implies "Specific User".
    const globalUser = document.getElementById('usageUser');
    globalUser?.addEventListener('input', () => {
        const v = globalUser.value.trim();
        filterMode = v ? 'specific' : 'all';
        syncUserFilterUI(v || null, filterMode);
    });
    // Single delegated handler for Filter buttons / user links in the Costs tables.
    document.addEventListener('click', ev => {
        const t = ev.target;
        if (!t || typeof t.closest !== 'function')
            return;
        const fu = t.closest('[data-filteruser]');
        if (fu?.dataset.filteruser) {
            ev.preventDefault();
            setUserFilter(fu.dataset.filteruser);
        }
    });
}
/**
 * True when the user is typing somewhere. The auto-refresh tick re-renders the
 * active tab, which replaces table bodies and re-populates form fields - so a
 * half-typed URL in Settings or a user search in Costs would be wiped out from
 * under the cursor every 15 seconds.
 */
function isEditing() {
    const el = document.activeElement;
    if (!el)
        return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
/** Document-level shortcuts, skipped while typing so they cannot eat keystrokes. */
function wireShortcuts() {
    document.addEventListener('keydown', e => {
        const ev = e;
        if (ev.ctrlKey || ev.metaKey || ev.altKey)
            return;
        const el = ev.target;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
            return;
        if (ev.key === 'r') {
            ev.preventDefault();
            void refreshAll();
            return;
        }
        if (ev.key === '/') {
            const search = document.getElementById('costUserSearch')
                ?? document.getElementById('usageUser');
            if (search) {
                ev.preventDefault();
                search.focus();
                search.select();
            }
        }
    });
}
function wireChrome() {
    document.querySelectorAll('[data-tab]').forEach(b => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    wireTabKeys();
    must('refreshBtn').addEventListener('click', () => void refreshAll());
    must('usageApply').addEventListener('click', () => void refreshAll());
    document.getElementById('usageUser')?.addEventListener('keydown', e => {
        if (e.key === 'Enter')
            void refreshAll();
    });
    must('logsRefresh').addEventListener('click', () => void safe('logs', () => renderLogs()));
    wireLogFilters(() => void safe('logs', () => renderLogs()));
    document.getElementById('themeBtn')?.addEventListener('click', toggleTheme);
    document.addEventListener('click', ev => {
        const t = ev.target;
        if (!t || typeof t.closest !== 'function')
            return;
        const del = t.closest('[data-delete]');
        if (del) {
            const name = del.dataset.delete || '';
            if (confirm(`Delete user "${name}"?`)) {
                api(`/api/admin/users/${encodeURIComponent(name)}`, { method: 'DELETE' })
                    .then(() => safe('users', () => renderUsers(currentFilter().days)))
                    .catch(e => flash('err', e.message));
            }
            return;
        }
        const edit = t.closest('[data-edit]');
        if (edit?.dataset.edit) {
            void openUserEditor(edit.dataset.edit);
            return;
        }
        const detail = t.closest('[data-detail]');
        if (detail?.dataset.detail) {
            void openUserDetail(detail.dataset.detail);
            return;
        }
    });
    document.addEventListener('ami:users-changed', () => {
        void safe('users', () => renderUsers(currentFilter().days));
    });
    // Raised after the token rates change, so the Costs tab re-reads its rates
    // rather than showing the previous ones until the next manual refresh.
    document.addEventListener('ami:refresh', () => { void refreshAll(); });
    setInterval(() => {
        if (document.hidden)
            return;
        // Never re-render out from under someone mid-keystroke. Manual refresh and
        // the r shortcut still work while typing - this guard is only for the timer.
        if (isEditing())
            return;
        const ar = document.getElementById('autoRefresh');
        if (!must('app').hidden && ar?.checked)
            void refreshAll();
    }, 15000);
}
function wireCertBackUrl() {
    const input = document.getElementById('certBackUrl');
    const btn = document.getElementById('certBackUrlSave');
    const msg = document.getElementById('certBackUrlMsg');
    if (!input || !btn || !msg)
        return;
    // Load current value from server config
    api('/api/admin/config')
        .then((cfg) => {
        if (cfg.helpdesk_url)
            input.value = cfg.helpdesk_url;
    })
        .catch(() => { });
    btn.addEventListener('click', async () => {
        const val = input.value.trim();
        if (!val) {
            msg.textContent = 'URL is required';
            return;
        }
        // Mirrors the server's own validation so the admin is told here rather than
        // after a round-trip. `new URL` on its own is not enough: it happily accepts
        // 'javascript:alert(1)', and this value is served straight into an href on
        // the page that sends the user back to their Helpdesk.
        let parsed;
        try {
            parsed = new URL(val);
        }
        catch {
            msg.textContent = 'Enter a full address, including https://';
            msg.className = 'small text-danger';
            return;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            msg.textContent = 'Must start with http:// or https://';
            msg.className = 'small text-danger';
            return;
        }
        try {
            const saved = await api('/api/admin/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ helpdesk_url: val })
            });
            // Show what was stored, not what was typed: the server normalises, and an
            // input that disagrees with the saved value reads as a failed save.
            if (saved && saved.helpdesk_url)
                input.value = saved.helpdesk_url;
            msg.textContent = 'Saved. This survives a restart.';
            msg.className = 'small text-success';
        }
        catch (e) {
            msg.textContent = e.message;
            msg.className = 'small text-danger';
        }
    });
}
function boot() {
    const fromUrl = new URLSearchParams(window.location.search).get('key');
    if (fromUrl) {
        setKey(fromUrl);
        history.replaceState(null, '', window.location.pathname);
    }
    applyStoredTheme();
    wireAuth();
    wireChrome();
    wireCostFilters();
    wireUserForm();
    wireRateEditor();
    wireTicketForms();
    wireCertBackUrl();
    wireSortableTables();
    wireShortcuts();
    if (!getKey()) {
        showLogin();
        return;
    }
    api('/api/admin/config')
        .then(() => { showApp(); return refreshAll(); })
        .catch(() => showLogin());
}
if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', boot);
else
    boot();
//# sourceMappingURL=main.js.map
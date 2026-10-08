// Dashboard entry (part 1): imports, tab router, guarded refresh.
import { api, clearKey, flash, getKey, setKey } from './api.js';
import { esc, must } from './utils.js';
import { renderOverview } from './tabs/overview.js';
import { renderTrends } from './tabs/trends.js';
import { renderCosts } from './tabs/costs.js';
import { renderUsers } from './tabs/users.js';
import { renderSessions } from './tabs/sessions.js';
import { renderRealtime } from './tabs/realtime.js';
import { renderLogs, wireLogFilters, openSession } from './tabs/inspect.js';
import { wireRateEditor } from './tabs/rates.js';
import { openUserDetail, openUserEditor, wireUserForm } from './tabs/user-admin.js';
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
    if (activeTab === 'logs')
        await safe('logs', () => renderLogs());
    stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
}
export function switchTab(id) {
    activeTab = id;
    document.querySelectorAll('[data-tab]').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === id);
    });
    document.querySelectorAll('[data-panel]').forEach(p => {
        p.hidden = p.dataset.panel !== id;
    });
    void refreshAll();
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
function wireChrome() {
    document.querySelectorAll('[data-tab]').forEach(b => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
    must('refreshBtn').addEventListener('click', () => void refreshAll());
    must('usageApply').addEventListener('click', () => void refreshAll());
    document.getElementById('usageUser')?.addEventListener('keydown', e => {
        if (e.key === 'Enter')
            void refreshAll();
    });
    must('logsRefresh').addEventListener('click', () => void safe('logs', () => renderLogs()));
    wireLogFilters(() => void safe('logs', () => renderLogs()));
    document.getElementById('themeBtn')?.addEventListener('click', () => {
        const html = document.documentElement;
        html.dataset.bsTheme = html.dataset.bsTheme === 'dark' ? 'light' : 'dark';
    });
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
        const sess = t.closest('[data-session]');
        if (sess?.dataset.session) {
            void openSession(sess.dataset.session);
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
        const ar = document.getElementById('autoRefresh');
        if (!must('app').hidden && ar?.checked)
            void refreshAll();
    }, 15000);
}
function boot() {
    const fromUrl = new URLSearchParams(window.location.search).get('key');
    if (fromUrl) {
        setKey(fromUrl);
        history.replaceState(null, '', window.location.pathname);
    }
    wireAuth();
    wireChrome();
    wireCostFilters();
    wireUserForm();
    wireRateEditor();
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
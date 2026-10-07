// Dashboard entry (part 1): imports, tab router, guarded refresh.
import { api, clearKey, flash, getKey, setKey } from './api';
import { must } from './utils';
import { renderOverview } from './tabs/overview';
import { renderTrends } from './tabs/trends';
import { renderCosts } from './tabs/costs';
import { renderUsers } from './tabs/users';
import { renderSessions } from './tabs/sessions';
import { renderRealtime } from './tabs/realtime';
import { openSession, renderLogs, wireLogFilters } from './tabs/inspect';
import { openUserDetail, openUserEditor, wireUserForm } from './tabs/user-admin';
let activeTab = 'overview';
export function currentFilter() {
    const days = Number(document.getElementById('usageDays')?.value || 30);
    const user = document.getElementById('usageUser')?.value.trim() || null;
    return { days: Number.isFinite(days) ? days : 30, username: user || null };
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
        const fu = t.closest('[data-filteruser]');
        if (fu?.dataset.filteruser) {
            ev.preventDefault();
            must('usageUser').value = fu.dataset.filteruser;
            switchTab('cost');
        }
    });
    document.addEventListener('ami:users-changed', () => {
        void safe('users', () => renderUsers(currentFilter().days));
    });
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
    wireUserForm();
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
// Dashboard entry (part 1): imports, tab router, guarded refresh.
import { api, clearKey, flash, getKey, setKey } from './api';
import { must } from './utils';
import { renderOverview, type OverviewFilter } from './tabs/overview';
import { renderTrends } from './tabs/trends';
import { renderCosts } from './tabs/costs';
import { renderUsers } from './tabs/users';
import { renderSessions } from './tabs/sessions';
import { renderRealtime } from './tabs/realtime';
import { openSession, renderLogs, wireLogFilters } from './tabs/inspect';
import { openUserDetail, openUserEditor, wireUserForm } from './tabs/user-admin';

export type TabId = 'overview' | 'trends' | 'cost' | 'users' | 'conv' | 'live' | 'logs';
let activeTab: TabId = 'overview';

export function currentFilter(): OverviewFilter {
  const days = Number((document.getElementById('usageDays') as HTMLSelectElement | null)?.value || 30);
  const user = (document.getElementById('usageUser') as HTMLInputElement | null)?.value.trim() || null;
  return { days: Number.isFinite(days) ? days : 30, username: user || null };
}

export async function safe(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[dashboard] tab "${name}" failed:`, e);
    flash('err', `${name}: ${(e as Error).message}`);
  }
}

export async function refreshAll(): Promise<void> {
  const f = currentFilter();
  const stamp = must('lastUpd');
  stamp.hidden = false;
  stamp.textContent = 'updating…';
  await safe('overview', () => renderOverview(f));
  if (activeTab === 'trends') await safe('trends', () => renderTrends(f));
  if (activeTab === 'cost') await safe('costs', () => renderCosts(f));
  if (activeTab === 'users') await safe('users', () => renderUsers(f.days));
  if (activeTab === 'conv') await safe('sessions', () => renderSessions(100));
  if (activeTab === 'live') await safe('live', () => renderRealtime());
  if (activeTab === 'logs') await safe('logs', () => renderLogs());
  stamp.textContent = 'updated ' + new Date().toLocaleTimeString();
}

export function switchTab(id: TabId): void {
  activeTab = id;
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === id);
  });
  document.querySelectorAll('[data-panel]').forEach(p => {
    (p as HTMLElement).hidden = (p as HTMLElement).dataset.panel !== id;
  });
  void refreshAll();
}


function showLogin(): void {
  must('login').hidden = false;
  must('app').hidden = true;
  (must('loginKey') as HTMLInputElement).value = getKey();
  setTimeout(() => (must('loginKey') as HTMLInputElement).focus(), 30);
}

function showApp(): void {
  must('login').hidden = true;
  must('app').hidden = false;
}

function signOut(msg?: string): void {
  clearKey();
  showLogin();
  if (msg) {
    const e = must('loginErr');
    e.textContent = msg;
    e.hidden = false;
  }
}

function wireAuth(): void {
  document.addEventListener('ami:unauthorized', () => signOut('Your admin key was rejected.'));
  must('loginForm').addEventListener('submit', ev => {
    ev.preventDefault();
    setKey((must('loginKey') as HTMLInputElement).value);
    must('loginErr').hidden = true;
    api('/api/admin/config')
      .then(() => { showApp(); return refreshAll(); })
      .catch(() => signOut('Could not verify that key.'));
  });
  must('logoutBtn').addEventListener('click', () => signOut());
}

function wireChrome(): void {
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.addEventListener('click', () => switchTab((b as HTMLElement).dataset.tab as TabId));
  });
  must('refreshBtn').addEventListener('click', () => void refreshAll());
  must('usageApply').addEventListener('click', () => void refreshAll());
  document.getElementById('usageUser')?.addEventListener('keydown', e => {
    if ((e as KeyboardEvent).key === 'Enter') void refreshAll();
  });
  must('logsRefresh').addEventListener('click', () => void safe('logs', () => renderLogs()));
  wireLogFilters(() => void safe('logs', () => renderLogs()));
  document.getElementById('themeBtn')?.addEventListener('click', () => {
    const html = document.documentElement;
    html.dataset.bsTheme = html.dataset.bsTheme === 'dark' ? 'light' : 'dark';
  });
  document.addEventListener('click', ev => {
    const t = ev.target as HTMLElement | null;
    if (!t || typeof t.closest !== 'function') return;
    const del = t.closest('[data-delete]') as HTMLElement | null;
    if (del) {
      const name = del.dataset.delete || '';
      if (confirm(`Delete user "${name}"?`)) {
        api(`/api/admin/users/${encodeURIComponent(name)}`, { method: 'DELETE' })
          .then(() => safe('users', () => renderUsers(currentFilter().days)))
          .catch(e => flash('err', (e as Error).message));
      }
      return;
    }
    const edit = t.closest('[data-edit]') as HTMLElement | null;
    if (edit?.dataset.edit) { void openUserEditor(edit.dataset.edit); return; }
    const detail = t.closest('[data-detail]') as HTMLElement | null;
    if (detail?.dataset.detail) { void openUserDetail(detail.dataset.detail); return; }
    const sess = t.closest('[data-session]') as HTMLElement | null;
    if (sess?.dataset.session) { void openSession(sess.dataset.session); return; }
    const fu = t.closest('[data-filteruser]') as HTMLElement | null;
    if (fu?.dataset.filteruser) {
      ev.preventDefault();
      (must('usageUser') as HTMLInputElement).value = fu.dataset.filteruser;
      switchTab('cost');
    }
  });
  document.addEventListener('ami:users-changed', () => {
    void safe('users', () => renderUsers(currentFilter().days));
  });
  setInterval(() => {
    if (document.hidden) return;
    const ar = document.getElementById('autoRefresh') as HTMLInputElement | null;
    if (!must('app').hidden && ar?.checked) void refreshAll();
  }, 15000);
}

function boot(): void {
  const fromUrl = new URLSearchParams(window.location.search).get('key');
  if (fromUrl) {
    setKey(fromUrl);
    history.replaceState(null, '', window.location.pathname);
  }
  wireAuth();
  wireChrome();
  wireUserForm();
  if (!getKey()) { showLogin(); return; }
  api('/api/admin/config')
    .then(() => { showApp(); return refreshAll(); })
    .catch(() => showLogin());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

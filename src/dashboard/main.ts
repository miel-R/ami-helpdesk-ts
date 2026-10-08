// Dashboard entry (part 1): imports, tab router, guarded refresh.
import { api, clearKey, flash, getKey, setKey } from './api.js';
import { esc, must } from './utils.js';
import { renderOverview, type OverviewFilter } from './tabs/overview.js';
import { renderTrends } from './tabs/trends.js';
import { renderCosts } from './tabs/costs.js';
import { renderUsers } from './tabs/users.js';
import { renderSessions } from './tabs/sessions.js';
import { renderRealtime } from './tabs/realtime.js';
import { renderLogs, wireLogFilters, openSession } from './tabs/inspect.js';
import { wireRateEditor } from './tabs/rates.js';
import { openUserDetail, openUserEditor, wireUserForm } from './tabs/user-admin.js';

export type TabId = 'overview' | 'trends' | 'cost' | 'users' | 'conv' | 'live' | 'logs';
let activeTab: TabId = 'overview';

export interface CostFilter extends OverviewFilter {
  filterMode: 'all' | 'specific';
  sessionLimit: number | 'all';
}

export function currentFilter(): OverviewFilter & { filterMode: 'all' | 'specific'; sessionLimit: number | 'all' } {
  const days = Number((document.getElementById('usageDays') as HTMLSelectElement | null)?.value || 1);
  const user = (document.getElementById('usageUser') as HTMLInputElement | null)?.value.trim() || null;
  return { 
    days: Number.isFinite(days) ? days : 1, 
    username: user || null,
    filterMode,
    sessionLimit
  };
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

// Costs tab filter state and handlers
let filterMode: 'all' | 'specific' = 'all';
let sessionLimit: number | 'all' = 50;

function costSearchInput(): HTMLInputElement | null {
  return document.getElementById('costUserSearch') as HTMLInputElement | null;
}

/** Keeps the global user filter, the Costs search box and the mode select in sync. */
function syncUserFilterUI(user: string | null, mode: 'all' | 'specific'): void {
  const globalUser = document.getElementById('usageUser') as HTMLInputElement | null;
  const search = costSearchInput();
  const modeSelect = document.getElementById('usageFilterMode') as HTMLSelectElement | null;
  const val = user || '';
  if (globalUser) globalUser.value = val;
  if (search) {
    search.value = val;
    search.style.display = mode === 'specific' ? '' : 'none';
  }
  if (modeSelect) modeSelect.value = mode;
}

/** Single entry point for applying a user filter from any UI affordance. */
function setUserFilter(user: string | null): void {
  const val = (user || '').trim();
  filterMode = val ? 'specific' : 'all';
  syncUserFilterUI(val || null, filterMode);
  void refreshAll();
}

async function suggestUsers(term: string): Promise<void> {
  const dl = document.getElementById('costUserOptions') as HTMLDataListElement | null;
  if (!dl) return;
  try {
    const res = await api<{ users: { username: string }[] }>(
      `/api/admin/users/search?q=${encodeURIComponent(term)}&limit=10`
    );
    dl.innerHTML = res.users.map(u => `<option value="${esc(u.username)}"></option>`).join('');
  } catch {
    dl.innerHTML = '';
  }
}

function wireCostFilters(): void {
  const modeSelect = document.getElementById('usageFilterMode') as HTMLSelectElement | null;
  const search = costSearchInput();
  const limitSelect = document.getElementById('sessionLimit') as HTMLSelectElement | null;

  if (modeSelect) {
    modeSelect.addEventListener('change', () => {
      if (modeSelect.value === 'specific') {
        filterMode = 'specific';
        const existing = (document.getElementById('usageUser') as HTMLInputElement | null)?.value.trim() || '';
        syncUserFilterUI(existing || null, 'specific');
        search?.focus();
      } else {
        setUserFilter(null);
        return;
      }
      void refreshAll();
    });
  }

  if (search) {
    let timer: number | undefined;
    search.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void suggestUsers(search.value.trim()), 200);
    });
    search.addEventListener('keydown', e => {
      if ((e as KeyboardEvent).key === 'Enter') {
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
  const globalUser = document.getElementById('usageUser') as HTMLInputElement | null;
  globalUser?.addEventListener('input', () => {
    const v = globalUser.value.trim();
    filterMode = v ? 'specific' : 'all';
    syncUserFilterUI(v || null, filterMode);
  });

  // Single delegated handler for Filter buttons / user links in the Costs tables.
  document.addEventListener('click', ev => {
    const t = ev.target as HTMLElement | null;
    if (!t || typeof t.closest !== 'function') return;
    const fu = t.closest('[data-filteruser]') as HTMLElement | null;
    if (fu?.dataset.filteruser) {
      ev.preventDefault();
      setUserFilter(fu.dataset.filteruser);
    }
  });
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
  });
  document.addEventListener('ami:users-changed', () => {
    void safe('users', () => renderUsers(currentFilter().days));
  });
  // Raised after the token rates change, so the Costs tab re-reads its rates
  // rather than showing the previous ones until the next manual refresh.
  document.addEventListener('ami:refresh', () => { void refreshAll(); });
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
  wireCostFilters();
  wireUserForm();
  wireRateEditor();
  if (!getKey()) { showLogin(); return; }
  api('/api/admin/config')
    .then(() => { showApp(); return refreshAll(); })
    .catch(() => showLogin());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

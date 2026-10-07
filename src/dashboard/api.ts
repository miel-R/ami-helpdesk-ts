// Admin auth + fetch wrapper. Single owner of the admin key so tabs never
// touch sessionStorage directly.
const KEY_STORE = 'ami_admin_key';

export function getKey(): string {
  return sessionStorage.getItem(KEY_STORE) || '';
}

export function setKey(k: string): void {
  sessionStorage.setItem(KEY_STORE, String(k || '').trim());
}

export function clearKey(): void {
  sessionStorage.removeItem(KEY_STORE);
}

export function withKey(pathname: string): string {
  const key = getKey();
  if (!key || /[?&]key=/.test(pathname)) return pathname;
  return pathname + (pathname.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}

export interface ApiError extends Error { status?: number; body?: unknown; }

export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> || {}) };
  const key = getKey();
  if (key) headers['X-Admin-Key'] = key;
  const r = await fetch(withKey(path), { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) {
    document.dispatchEvent(new CustomEvent('ami:unauthorized', { detail: body }));
    const err = new Error((body as { error?: string }).error || 'Unauthorized') as ApiError;
    err.status = 401;
    throw err;
  }
  if (!r.ok) {
    const err = new Error((body as { error?: string }).error || `HTTP ${r.status}`) as ApiError;
    err.status = r.status;
    err.body = body;
    throw err;
  }
  return body as T;
}

export function flash(kind: 'ok' | 'err', msg: string): void {
  const okEl = document.getElementById('okMsg');
  const errEl = document.getElementById('errMsg');
  if (!okEl || !errEl) return;
  const show = kind === 'ok' ? okEl : errEl;
  const hide = kind === 'ok' ? errEl : okEl;
  hide.hidden = true;
  if (!msg) { show.hidden = true; return; }
  show.textContent = msg;
  show.hidden = false;
  if (kind === 'ok') setTimeout(() => { show.hidden = true; }, 4000);
}

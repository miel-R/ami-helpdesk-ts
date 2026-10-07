// Admin auth + fetch wrapper. Single owner of the admin key so tabs never
// touch sessionStorage directly.
const KEY_STORE = 'ami_admin_key';
export function getKey() {
    return sessionStorage.getItem(KEY_STORE) || '';
}
export function setKey(k) {
    sessionStorage.setItem(KEY_STORE, String(k || '').trim());
}
export function clearKey() {
    sessionStorage.removeItem(KEY_STORE);
}
export function withKey(pathname) {
    const key = getKey();
    if (!key || /[?&]key=/.test(pathname))
        return pathname;
    return pathname + (pathname.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
}
export async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const key = getKey();
    if (key)
        headers['X-Admin-Key'] = key;
    const r = await fetch(withKey(path), { ...opts, headers });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) {
        document.dispatchEvent(new CustomEvent('ami:unauthorized', { detail: body }));
        const err = new Error(body.error || 'Unauthorized');
        err.status = 401;
        throw err;
    }
    if (!r.ok) {
        const err = new Error(body.error || `HTTP ${r.status}`);
        err.status = r.status;
        err.body = body;
        throw err;
    }
    return body;
}
export function flash(kind, msg) {
    const okEl = document.getElementById('okMsg');
    const errEl = document.getElementById('errMsg');
    if (!okEl || !errEl)
        return;
    const show = kind === 'ok' ? okEl : errEl;
    const hide = kind === 'ok' ? errEl : okEl;
    hide.hidden = true;
    if (!msg) {
        show.hidden = true;
        return;
    }
    show.textContent = msg;
    show.hidden = false;
    if (kind === 'ok')
        setTimeout(() => { show.hidden = true; }, 4000);
}
//# sourceMappingURL=api.js.map
// Formatting + DOM helpers shared by every dashboard tab module.
// One import site for esc/nfmt/usd/when/ago so a fix here fixes all tabs.
export function esc(v) {
    if (v === null || v === undefined)
        return '';
    return String(v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
export function $(id) {
    return document.getElementById(id);
}
export function must(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`[dashboard] missing element #${id}`);
    return el;
}
export function nfmt(n) {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 1e9)
        return (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6)
        return (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e3)
        return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
}
export function usd(n) {
    const v = Number(n) || 0;
    if (v === 0)
        return '$0.00';
    if (Math.abs(v) < 0.01)
        return '$' + v.toFixed(6);
    return '$' + v.toFixed(2);
}
export function bytes(n) {
    const v = Number(n) || 0;
    if (!v)
        return '—';
    if (v >= 1073741824)
        return (v / 1073741824).toFixed(1) + ' GB';
    if (v >= 1048576)
        return (v / 1048576).toFixed(1) + ' MB';
    if (v >= 1024)
        return (v / 1024).toFixed(0) + ' KB';
    return v + ' B';
}
export function when(iso) {
    if (!iso)
        return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return String(iso);
    return d.toLocaleString();
}
export function ago(iso) {
    if (!iso)
        return '—';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (Number.isNaN(s))
        return '—';
    if (s < 0)
        return 'just now';
    if (s < 60)
        return s + 's ago';
    if (s < 3600)
        return Math.floor(s / 60) + 'm ago';
    if (s < 86400)
        return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
}
export function uptime(s) {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    const d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60), sec = t % 60;
    if (d)
        return `${d}d ${h}h`;
    if (h)
        return `${h}h ${m}m`;
    if (m)
        return `${m}m ${sec}s`;
    return `${sec}s`;
}
/** Delta pill: ▲ green / ▼ red / — neutral. Costs invert (up = bad). */
export function deltaPill(pct, invert = false) {
    if (pct === null || pct === undefined)
        return '<span class="text-muted">—</span>';
    const up = pct > 0.05, down = pct < -0.05;
    if (!up && !down)
        return '<span class="badge bg-secondary-subtle text-secondary">±0%</span>';
    const good = invert ? down : up;
    const cls = good ? 'bg-success-subtle text-success' : 'bg-danger-subtle text-danger';
    const arrow = up ? '▲' : '▼';
    return `<span class="badge ${cls}">${arrow} ${esc(Math.abs(pct).toFixed(1))}%</span>`;
}
//# sourceMappingURL=utils.js.map
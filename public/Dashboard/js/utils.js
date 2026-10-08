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
/**
 * Dollars at full precision, for costs small enough that rounding them away
 * would print every row as $0.00.
 *
 * The dashboard's other money columns use the short form, which is right for a
 * daily or monthly total. A single session's cost at $0.30/1M input tokens is a
 * fraction of a cent, so six decimals is the difference between a number and a
 * row of zeros. Non-finite input collapses to $0 rather than printing $NaN.
 */
export function usd6(n) {
    const v = typeof n === 'number' ? n : parseFloat(String(n ?? ''));
    if (!Number.isFinite(v))
        return '$0.000000';
    const sign = v < 0 ? '-' : '';
    return `${sign}$${Math.abs(v).toFixed(6)}`;
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
export function exportTableToCSV(filename, headers, rows, options) {
    const opts = {
        includeHeaders: true,
        format: 'csv',
        dateFormat: 'iso',
        filename: '',
        headers: [],
        rows: [],
        ...options
    };
    if (opts.format === 'json') {
        const data = opts.includeHeaders ? rows : rows.map(r => {
            const obj = {};
            for (const h of headers) {
                const val = r[h];
                const fn = opts.transform || ((_, v) => v);
                obj[opts.columnMap?.[h] ?? h] = fn(h, val);
            }
            return obj;
        });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename.replace(/\.csv$/i, '.json');
        link.click();
        URL.revokeObjectURL(link.href);
        return;
    }
    const csvRows = [];
    const effectiveHeaders = opts.columnMap ? Object.keys(opts.columnMap).map(h => opts.columnMap[h]) : headers;
    if (true) { // always include headers for now
        csvRows.push(effectiveHeaders.join(','));
    }
    for (const row of rows) {
        const vals = headers.map(h => {
            const val = row[h];
            if (val === null || val === undefined)
                return '';
            let str = String(val);
            // Optional transform
            if (opts.transform) {
                str = opts.transform(h, val);
            }
            // Format dates if dateFormat is specified
            if (opts.dateFormat === 'iso' && val instanceof Date) {
                str = val.toISOString();
            }
            else if (opts.dateFormat === 'locale' && val instanceof Date) {
                str = val.toLocaleString();
            }
            // Escape quotes and wrap in quotes if contains comma, quote, or newline
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        });
        csvRows.push(vals.join(','));
    }
    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}
//# sourceMappingURL=utils.js.map
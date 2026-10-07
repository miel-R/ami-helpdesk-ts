const registry = new Map();
function ctor() {
    const C = globalThis.Chart;
    return (typeof C === 'function' ? C : null);
}
export function chartAvailable() {
    return ctor() !== null;
}
function make(canvasId, type, labels, datasets, extra) {
    const C = ctor();
    const canvas = document.getElementById(canvasId);
    if (!C || !canvas)
        return false;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return false;
    registry.get(canvasId)?.destroy();
    try {
        registry.set(canvasId, new C(ctx, {
            type,
            data: { labels, datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'top' }, tooltip: { mode: 'index', intersect: false } },
                scales: { y: { beginAtZero: true } },
                ...(extra ?? {}),
            },
        }));
        return true;
    }
    catch (e) {
        console.error(`[dashboard] chart ${canvasId} failed:`, e);
        return false;
    }
}
export function lineChart(canvasId, labels, datasets, extra) {
    return make(canvasId, 'line', labels, datasets, { interaction: { mode: 'index', intersect: false }, ...extra });
}
export function barChart(canvasId, labels, datasets, extra) {
    return make(canvasId, 'bar', labels, datasets, extra);
}
export function doughnutChart(canvasId, labels, values, colors) {
    const C = ctor();
    const canvas = document.getElementById(canvasId);
    if (!C || !canvas)
        return false;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return false;
    registry.get(canvasId)?.destroy();
    try {
        registry.set(canvasId, new C(ctx, {
            type: 'doughnut',
            data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 1 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
        }));
        return true;
    }
    catch (e) {
        console.error(`[dashboard] doughnut ${canvasId} failed:`, e);
        return false;
    }
}
/** Tiny inline sparkline for KPI cards. */
export function sparkline(canvasId, values, color = '#6f42c1') {
    const C = ctor();
    const canvas = document.getElementById(canvasId);
    if (!C || !canvas || !values.length)
        return;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    registry.get(canvasId)?.destroy();
    try {
        registry.set(canvasId, new C(ctx, {
            type: 'line',
            data: { labels: values.map((_, i) => String(i)), datasets: [{ data: values, borderColor: color, borderWidth: 1.5, pointRadius: 0, tension: 0.3 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: { x: { display: false }, y: { display: false } },
                animation: false,
            },
        }));
    }
    catch { /* sparkline is decorative; never throw */ }
}
export function destroyAll() {
    for (const c of registry.values()) {
        try {
            c.destroy();
        }
        catch { /* noop */ }
    }
    registry.clear();
}
//# sourceMappingURL=charts.js.map
// Chart.js wrapper: one registry so re-renders destroy before recreating.
// Without the destroy, every auto-refresh leaked a chart and stacked tooltips.
declare const Chart: unknown;

type ChartLike = { destroy(): void };
type ChartCtor = new (ctx: CanvasRenderingContext2D, cfg: unknown) => ChartLike;

const registry = new Map<string, ChartLike>();

function ctor(): ChartCtor | null {
  const C = (globalThis as unknown as Record<string, unknown>).Chart;
  return (typeof C === 'function' ? C : null) as ChartCtor | null;
}

export function chartAvailable(): boolean {
  return ctor() !== null;
}

function make(canvasId: string, type: string, labels: string[], datasets: unknown[], extra?: Record<string, unknown>): boolean {
  const C = ctor();
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!C || !canvas) return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
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
  } catch (e) {
    console.error(`[dashboard] chart ${canvasId} failed:`, e);
    return false;
  }
}

export function lineChart(canvasId: string, labels: string[], datasets: unknown[], extra?: Record<string, unknown>): boolean {
  return make(canvasId, 'line', labels, datasets, { interaction: { mode: 'index', intersect: false }, ...extra });
}

export function barChart(canvasId: string, labels: string[], datasets: unknown[], extra?: Record<string, unknown>): boolean {
  return make(canvasId, 'bar', labels, datasets, extra);
}

export function doughnutChart(canvasId: string, labels: string[], values: number[], colors: string[]): boolean {
  const C = ctor();
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!C || !canvas) return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  registry.get(canvasId)?.destroy();
  try {
    registry.set(canvasId, new C(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right' } } },
    }));
    return true;
  } catch (e) {
    console.error(`[dashboard] doughnut ${canvasId} failed:`, e);
    return false;
  }
}

/** Tiny inline sparkline for KPI cards. */
export function sparkline(canvasId: string, values: number[], color = '#6f42c1'): void {
  const C = ctor();
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!C || !canvas || !values.length) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
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
      } as unknown,
    }));
  } catch { /* sparkline is decorative; never throw */ }
}

export function destroyAll(): void {
  for (const c of registry.values()) { try { c.destroy(); } catch { /* noop */ } }
  registry.clear();
}

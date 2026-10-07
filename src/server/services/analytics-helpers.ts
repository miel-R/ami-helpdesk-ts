// Analytics helpers shared by the breakdown / realtime / users services.
export function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Midnight-UTC key for a timestamp, e.g. "2026-10-07". */
export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Every day in [start, start+days) ascending, as "YYYY-MM-DD". */
export function eachDay(startIso: string, days: number): string[] {
  const out: string[] = [];
  const base = new Date(`${startIso}T00:00:00.000Z`).getTime();
  for (let i = 0; i < days; i++) {
    out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** % change of cur vs prev. null when there is no baseline. */
export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return cur ? 100 : null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}

export function fmtUsd(n: number): string {
  if (!n) return '$0.00';
  if (Math.abs(n) < 0.01) return '$' + n.toFixed(6);
  return '$' + n.toFixed(2);
}

export function fmtInt(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
}

export function avg(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
}

export function roundCost(n: unknown): number {
  return Math.round(num(n, 0) * 1e10) / 1e10;
}

// Drill-downs: session transcript modal + audit log table.
import { api, flash } from '../api';
import { esc, must, nfmt, usd, when } from '../utils';
import { openModal } from '../modal';

export async function openSession(sessionId: string): Promise<void> {
  try {
    const data = await api<{
      session_id: string; totals: { calls: number; total_tokens: number; cost_usd: number };
      messages: Array<Record<string, unknown>>; live: Record<string, unknown> | null;
    }>(`/api/usage/session/${encodeURIComponent(sessionId)}`);
    const rows = (data.messages || []).map(m => `<tr><td class="small">${esc(when(String(m.created_at || '')))}</td>
      <td class="mono small">${esc(String(m.model || m.provider || ''))}</td>
      <td class="text-end">${nfmt(m.total_tokens)}</td>
      <td class="text-end">${usd(m.cost_usd)}</td></tr>`).join('');
    openModal(`Session ${sessionId.slice(0, 12)}…`, `
      <p class="small text-muted">${data.totals.calls} calls · ${nfmt(data.totals.total_tokens)} tokens · ${usd(data.totals.cost_usd)}</p>
      <div class="table-responsive"><table class="table table-sm">
        <thead><tr><th>When</th><th>Model</th><th class="text-end">Tokens</th><th class="text-end">Cost</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="text-muted">No ledger rows</td></tr>'}</tbody>
      </table></div>`);
  } catch (e) { flash('err', (e as Error).message); }
}

let logLevel = 'all';

export function currentLogLevel(): string {
  return logLevel;
}

export async function renderLogs(): Promise<void> {
  const host = must('logBody');
  host.innerHTML = '<tr><td colspan="4" class="text-center text-muted py-3">Loading logs…</td></tr>';
  try {
    const data = await api<{ logs: Array<{ ts: string; level: string; event: string; detail: unknown }> }>('/api/logs?limit=200');
    const logs = (data.logs || []).filter(l => logLevel === 'all' || l.level === logLevel);
    host.innerHTML = logs.map(l => `<tr><td class="mono small">${esc(when(l.ts))}</td>
      <td><span class="badge ${l.level === 'error' ? 'bg-danger' : l.level === 'warn' ? 'bg-warning text-dark' : 'bg-info text-dark'}">${esc(l.level)}</span></td>
      <td class="mono small">${esc(l.event)}</td>
      <td class="mono small text-muted">${esc(JSON.stringify(l.detail ?? {}).slice(0, 220))}</td></tr>`).join('')
      || '<tr><td colspan="4" class="text-center text-muted py-3">No logs at this level</td></tr>';
  } catch (e) {
    host.innerHTML = '<tr><td colspan="4" class="text-center text-danger py-3">Failed to load logs</td></tr>';
    flash('err', (e as Error).message);
  }
}

export function wireLogFilters(onChange: () => void): void {
  document.querySelectorAll('[data-lvl]').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-lvl]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      logLevel = (b as HTMLElement).dataset.lvl || 'all';
      onChange();
    });
  });
}

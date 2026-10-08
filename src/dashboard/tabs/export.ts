// Export controls for the Costs tables.
//
// The utility in utils.ts only builds a blob and clicks a hidden link; it has no
// opinion about where the button lives or what the columns mean. This owns that,
// so every table exports the same way and the same mistakes are made once.
//
// The "all" option exists because the session table has a limit selector. Exporting
// what is on screen is the default, but exporting a truncated view under a filename
// that says nothing about it is how someone reconciles a spreadsheet against the
// dashboard, gets different totals, and concludes the dashboard is wrong. So the
// full export refetches with limit=all rather than re-reading the DOM, and the
// filename carries the user filter it was scoped to.
import { api, flash } from '../api.js';
import { exportTableToCSV } from '../utils.js';

/** One exportable column: a header label and how to read its value off a row. */
export interface ExportColumn {
  header: string;
  value: (row: never) => unknown;
}

export interface ExportSpec {
  /** Button text. */
  label: string;
  /** Base filename; the extension is added by the exporter. */
  filename: string;
  columns: ExportColumn[];
  /** Rows currently rendered, used by the "current view" options. */
  current: unknown[];
  /**
   * Re-fetches every row, ignoring the on-screen limit. Omit for tables with no
   * row limit, which makes the "all" option pointless.
   */
  fetchAll?: () => Promise<unknown[]>;
  /** Appended to the filename so an export cannot be mistaken for another. */
  scopeNote?: string;
}

const MENU_CSS = 'dropdown-menu dropdown-menu-end';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Turns typed rows into the flat key/value shape the exporter wants. */
function toRecords(spec: ExportSpec, rows: unknown[]): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const col of spec.columns) {
      out[col.header] = col.value(row as never);
    }
    return out;
  });
}

function download(spec: ExportSpec, rows: unknown[], format: 'csv' | 'json'): void {
  if (!rows.length) {
    flash('err', 'Nothing to export — no rows in the current view.');
    return;
  }
  const headers = spec.columns.map(c => c.header);
  const name = `${spec.filename}${spec.scopeNote ? `-${spec.scopeNote}` : ''}-${stamp()}.csv`;
  // Costs are stored unrounded; export the same 6dp the table shows so a
  // spreadsheet sum matches the dashboard instead of drifting on tiny values.
  exportTableToCSV(name, headers, toRecords(spec, rows), {
    format,
    includeHeaders: true,
    headers,
    rows: toRecords(spec, rows)
  });
}

function item(label: string, action: string): string {
  return `<li><a class="dropdown-item" href="#" data-export="${action}">${label}</a></li>`;
}

/** Builds the dropdown into `host`. Safe to call repeatedly on re-render. */
export function mountExport(host: HTMLElement, spec: ExportSpec): void {
  const hasAll = typeof spec.fetchAll === 'function';
  host.innerHTML =
    `<div class="btn-group">` +
      `<button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" ` +
        `data-bs-toggle="dropdown" aria-expanded="false">${spec.label}</button>` +
      `<ul class="${MENU_CSS}">` +
        item(`CSV &mdash; current view`, 'csv') +
        item(`JSON &mdash; current view`, 'json') +
        (hasAll ? `<li><hr class="dropdown-divider"></li>` + item(`CSV &mdash; all rows`, 'csv-all') : '') +
      `</ul>` +
    `</div>`;

  host.querySelectorAll('[data-export]').forEach(node => {
    node.addEventListener('click', async ev => {
      ev.preventDefault();
      const action = (node as HTMLElement).dataset.export || 'csv';
      // Collapse the menu, otherwise it stays open over the table it just exported.
      const toggle = host.querySelector('[data-bs-toggle="dropdown"]') as HTMLElement | null;
      if (toggle) {
        const inst = (window as unknown as { bootstrap?: { Dropdown?: { getOrCreateInstance(el: Element): { hide(): void } } } })
          .bootstrap?.Dropdown?.getOrCreateInstance(toggle);
        inst?.hide();
      }

      if (action === 'csv' || action === 'json') {
        download(spec, spec.current, action === 'csv' ? 'csv' : 'json');
        return;
      }
      if (!spec.fetchAll) return;
      try {
        const all = await spec.fetchAll();
        download(spec, all, 'csv');
        flash('ok', `Exported ${all.length} rows (all rows, not just the ${spec.current.length} shown).`);
      } catch (e) {
        flash('err', `Export failed: ${(e as Error).message}`);
      }
    });
  });
}

/** Re-fetches every session, honouring the active user filter. */
export async function fetchAllSessions(f: { username?: string | null }): Promise<unknown[]> {
  const q = f.username ? `&username=${encodeURIComponent(f.username)}` : '';
  const res = await api<{ sessions: unknown[] }>(`/api/analytics/sessions?limit=all${q}`);
  return res.sessions || [];
}
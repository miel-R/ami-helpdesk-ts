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
/**
 * Costs are exported at the same 6dp the tables show, so a sum still ties out.
 *
 * Exported rather than kept private: the Costs tab rounds its own cost columns
 * this way too, and two copies of a rounding rule is one too many - they agree
 * today, and the export quietly stops tying out to the screen the day they do not.
 */
export function round6(n) {
    return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
}
/**
 * The session export columns, shared by the Costs "Per Session Cost" table and
 * the Sessions tab.
 *
 * Both tables render the same `/api/analytics/sessions` payload, so defining the
 * columns twice meant a column added to one export was silently missing from the
 * other, and the two files of "the same" session data could disagree. One
 * definition is the only way to keep them honest.
 *
 * Values come from the API payload, never scraped back out of the DOM: the
 * rendered rows are abbreviated (dates localised, costs rounded), so scraping
 * would produce a file that does not reconcile with the numbers on screen.
 */
export const sessionColumns = [
    { header: 'Session', value: (s) => s.session_id },
    { header: 'User', value: (s) => s.user },
    { header: 'Mode', value: (s) => s.mode },
    { header: 'State', value: (s) => s.status },
    { header: 'Msgs In', value: (s) => s.user_messages },
    { header: 'Msgs Out', value: (s) => s.assistant_messages },
    { header: 'Files', value: (s) => s.files_count },
    { header: 'Input Tokens', value: (s) => s.input_tokens },
    { header: 'Output Tokens', value: (s) => s.output_tokens },
    { header: 'IT Cost', value: (s) => round6(s.input_cost_usd) },
    { header: 'OT Cost', value: (s) => round6(s.output_cost_usd) },
    { header: 'Total Cost', value: (s) => round6(s.cost_usd) },
    { header: 'Start', value: (s) => s.created_at || '' },
    { header: 'End', value: (s) => s.last_activity || '' },
];
const MENU_CSS = 'dropdown-menu dropdown-menu-end';
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
/** Turns typed rows into the flat key/value shape the exporter wants. */
function toRecords(spec, rows) {
    return rows.map(row => {
        const out = {};
        for (const col of spec.columns) {
            out[col.header] = col.value(row);
        }
        return out;
    });
}
function download(spec, rows, format) {
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
function item(label, action) {
    return `<li><a class="dropdown-item" href="#" data-export="${action}">${label}</a></li>`;
}
/** Builds the dropdown into `host`. Safe to call repeatedly on re-render. */
export function mountExport(host, spec) {
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
        node.addEventListener('click', async (ev) => {
            ev.preventDefault();
            const action = node.dataset.export || 'csv';
            // Collapse the menu, otherwise it stays open over the table it just exported.
            const toggle = host.querySelector('[data-bs-toggle="dropdown"]');
            if (toggle) {
                const inst = window
                    .bootstrap?.Dropdown?.getOrCreateInstance(toggle);
                inst?.hide();
            }
            if (action === 'csv' || action === 'json') {
                download(spec, spec.current, action === 'csv' ? 'csv' : 'json');
                return;
            }
            if (!spec.fetchAll)
                return;
            try {
                const all = await spec.fetchAll();
                download(spec, all, 'csv');
                flash('ok', `Exported ${all.length} rows (all rows, not just the ${spec.current.length} shown).`);
            }
            catch (e) {
                flash('err', `Export failed: ${e.message}`);
            }
        });
    });
}
/** Re-fetches every session, honouring the active user filter. */
export async function fetchAllSessions(f) {
    const q = f.username ? `&username=${encodeURIComponent(f.username)}` : '';
    const res = await api(`/api/analytics/sessions?limit=all${q}`);
    return res.sessions || [];
}
//# sourceMappingURL=export.js.map
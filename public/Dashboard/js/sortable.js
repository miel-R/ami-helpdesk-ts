// Client-side sorting for the analytics tables.
//
// Why it exists: the questions this dashboard exists to answer - which user cost
// the most, which sessions were slowest, which model is burning money - are all
// "find the maximum" questions, and every table rendered in server order with no
// way to reorder it. A generic header sorter beats eight bespoke implementations.
//
// Design notes:
//   - Opt-in per table via `data-sortable` on the <table>, and per column via
//     `data-sort-col` on its <th>. Tables that need a specific order (logs, which
//     are newest-first) simply leave it off, so this never fights them.
//   - The column kind is declared, never inferred from cell content. Inference is
//     a trap here: "1,234", "12.5%", "$0.30" and "—" all need different handling,
//     and a column that is numeric today can hold an em-dash tomorrow.
//   - Sorting reorders existing <tr> nodes rather than rebuilding markup, so a row
//     keeps its event listeners and this code never has to know what a row means.
//   - Re-sorts in place after a live refresh, so the chosen ordering survives the
//     15-second auto-refresh instead of silently snapping back to server order.
const DASHES = new Set(['', '-', '--', '—', '–']);
function colKind(th) {
    const k = th.dataset.sortCol;
    return k === 'num' || k === 'date' ? k : 'text';
}
/**
 * Parse a cell to the number it displays. Strips currency, thousands separators
 * and percent signs, so "$1,234.50" and "12.5%" both compare as magnitudes.
 * Returns NaN when there is no number in the cell at all.
 */
export function _parseNum(text) {
    const cleaned = text.replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.')
        return NaN;
    return parseFloat(cleaned);
}
/**
 * Builds the comparator for one column in one direction, with blanks pinned to
 * the bottom in BOTH directions.
 *
 * The obvious implementation - `asc ? compare(a, b) : -compare(a, b)` - cannot
 * do this, and not because of a missing negation. Descending negates the whole
 * result, so any rule that compare() applies to a blank pair gets reversed
 * along with everything else. Making blanks sort last ascending therefore forces
 * them to sort first descending, which is exactly the bug this wrapper exists to
 * avoid. (A comparator with a special blank branch cannot be both blank-last in
 * each direction and antisymmetric, so the branch cannot live in compare() at
 * all - it has to sit outside, ahead of the direction flip.)
 *
 * So: settle blanks first, then delegate, and only negate the value comparison.
 */
export function _comparatorFor(kind, asc) {
    return (a, b) => {
        const aDash = DASHES.has(a);
        const bDash = DASHES.has(b);
        if (aDash || bDash) {
            if (aDash && bDash)
                return 0;
            return aDash ? 1 : -1;
        }
        const cmp = _compare(kind, a, b);
        return asc ? cmp : -cmp;
    };
}
/**
 * Compares two non-blank cell values. Blanks are settled by comparatorFor()
 * before this runs; a blank reaching here would be a bug, not a case to handle.
 * Returns a signed magnitude (a difference, not just -1/0/1), which is what lets
 * Array.sort keep equal rows in their original order instead of shuffling them.
 */
export function _compare(kind, a, b) {
    if (kind === 'num') {
        const av = _parseNum(a);
        const bv = _parseNum(b);
        const aNum = Number.isFinite(av);
        const bNum = Number.isFinite(bv);
        if (!aNum || !bNum) {
            if (aNum)
                return -1;
            if (bNum)
                return 1;
            return a.localeCompare(b);
        }
        return av - bv;
    }
    if (kind === 'date') {
        const at = Date.parse(a);
        const bt = Date.parse(b);
        const aDate = !Number.isNaN(at);
        const bDate = !Number.isNaN(bt);
        if (!aDate || !bDate) {
            if (aDate)
                return -1;
            if (bDate)
                return 1;
            return a.localeCompare(b);
        }
        return at - bt;
    }
    // numeric collation so "item 9" sorts before "item 10".
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
/** Cell text with any previously-injected arrow removed. */
function cellText(row, index) {
    const cell = row.cells[index];
    if (!cell)
        return '';
    return (cell.textContent || '').replace(/[\s▲▼]+$/, '').trim();
}
const wired = new Map();
function wireTable(table) {
    const tbody = table.tBodies[0];
    if (!tbody)
        return;
    const headers = Array.from(table.querySelectorAll('thead th'));
    const cols = headers
        .map((th, index) => ({ th: th, index }))
        .filter(c => !!c.th.dataset.sortCol)
        .map(c => ({ ...c, kind: colKind(c.th) }));
    if (!cols.length)
        return;
    const clearIndicators = () => {
        for (const c of cols) {
            c.th.removeAttribute('aria-sort');
            c.th.classList.remove('sort-active', 'sort-asc', 'sort-desc');
            c.th.querySelector('.sort-arrow')?.remove();
        }
    };
    const apply = (colIndex, asc) => {
        const col = cols[colIndex];
        if (!col)
            return;
        // Read every key once instead of cloning cells inside the comparator, then
        // sort the pre-keyed pairs through the same comparator the tests exercise -
        // lifted over so the blank-handling rules cannot drift between the two.
        const rows = Array.from(tbody.rows);
        const keyed = rows.map(row => ({ row, key: cellText(row, col.index) }));
        const cmp = _comparatorFor(col.kind, asc);
        keyed.sort((a, b) => cmp(a.key, b.key));
        clearIndicators();
        // One fragment, one reflow.
        const frag = document.createDocumentFragment();
        for (const k of keyed)
            frag.appendChild(k.row);
        tbody.appendChild(frag);
        col.th.classList.add('sort-active', asc ? 'sort-asc' : 'sort-desc');
        col.th.setAttribute('aria-sort', asc ? 'ascending' : 'descending');
        const arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.setAttribute('aria-hidden', 'true');
        arrow.textContent = asc ? '▲' : '▼';
        col.th.appendChild(arrow);
        const record = wired.get(table);
        if (record)
            record.state = { index: colIndex, asc };
    };
    for (const c of cols) {
        c.th.classList.add('sortable');
        c.th.setAttribute('tabindex', '0');
        const trigger = () => {
            const current = wired.get(table)?.state;
            const nextAsc = current && current.index === c.index ? !current.asc : true;
            apply(c.index, nextAsc);
        };
        c.th.addEventListener('click', trigger);
        c.th.addEventListener('keydown', (e) => {
            const k = e.key;
            if (k === 'Enter' || k === ' ') {
                e.preventDefault();
                trigger();
            }
        });
    }
    wired.set(table, { state: null, apply });
}
/** Attach header sorters to every `table[data-sortable]`. Call once at boot. */
export function wireSortableTables() {
    document.querySelectorAll('table[data-sortable]').forEach(t => wireTable(t));
}
/**
 * Re-apply each table's active sort to freshly rendered rows. Call after a tab
 * re-renders, otherwise the 15s auto-refresh would undo the admin's ordering.
 */
export function resortTables() {
    wired.forEach(record => {
        if (!record.state)
            return;
        // The tbody was replaced, so only the visible rows are re-ordered; the
        // state itself is left alone because apply() rewrites it to the same value.
        record.apply(record.state.index, record.state.asc);
    });
}
/** Forget the recorded sort for a table. Used by tests. */
export function _resetSortState() {
    wired.clear();
}
//# sourceMappingURL=sortable.js.map
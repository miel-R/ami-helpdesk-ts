// Token rate editor, reached from the Live tab.
//
// The rates live on the server rather than in the browser because every cost on
// the Costs tab is priced with them, and a rate that existed only in one admin's
// browser would make two people read different numbers off the same table.
import { api, flash } from '../api.js';
import { esc, must } from '../utils.js';
import { closeModalById, openModalById } from '../modal.js';
const DEFAULTS = { input_per_million: 0.30, output_per_million: 2.50, source: 'default' };
/** Short label for the Live tab card, e.g. "$0.30 / $2.50". */
export function ratesSummary(r) {
    return `$${r.input_per_million.toFixed(2)} / $${r.output_per_million.toFixed(2)}`;
}
/** Fetches the current rates and fills the Live tab's rate card. */
export async function renderRateCard() {
    const card = document.getElementById('liveRates');
    if (!card)
        return;
    try {
        const res = await api('/api/admin/cost-rates');
        const r = res.rates;
        card.innerHTML =
            `<span class="small text-muted d-block">Cost per 1M tokens</span>` +
                `<span class="h6 fw-bold mb-0">${esc(ratesSummary(r))}</span>` +
                `<span class="small text-muted ms-1">${r.source === 'custom' ? 'custom' : 'default'}</span>`;
        card.dataset.input = String(r.input_per_million);
        card.dataset.output = String(r.output_per_million);
        card.title = `Input $${r.input_per_million}/1M · Output $${r.output_per_million}/1M — click to edit`;
    }
    catch {
        card.innerHTML = '<span class="small text-muted">Rates unavailable</span>';
    }
}
async function loadIntoForm() {
    try {
        const res = await api('/api/admin/cost-rates');
        must('rateInput').value = String(res.rates.input_per_million);
        must('rateOutput').value = String(res.rates.output_per_million);
        setMsg('', '');
    }
    catch (e) {
        // Prefill the shipped defaults so the form is usable even if the read failed;
        // saving then still works, because the server owns the real values.
        must('rateInput').value = String(DEFAULTS.input_per_million);
        must('rateOutput').value = String(DEFAULTS.output_per_million);
        setMsg('warn', `Could not load current rates: ${e.message}`);
    }
}
function setMsg(kind, text) {
    const el = must('rateMsg');
    const cls = kind === 'ok' ? 'text-success' : kind === 'warn' ? 'text-warning' : kind === 'err' ? 'text-danger' : '';
    el.className = `small mt-3 ${cls}`.trim();
    el.textContent = text;
}
export async function openRateEditor() {
    openModalById('rateModal');
    await loadIntoForm();
}
async function save(input, output) {
    try {
        await api('/api/admin/cost-rates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input_per_million: input, output_per_million: output })
        });
        closeModalById('rateModal');
        await renderRateCard();
        // The Costs tab renders from the API rather than caching, so re-drawing it is
        // enough to show the new rates. Dispatched rather than imported so this module
        // stays independent of the tab router.
        document.dispatchEvent(new CustomEvent('ami:rates-changed'));
        flash('ok', 'Token rates saved. Costs recalculated.');
    }
    catch (e) {
        setMsg('err', e.message);
    }
}
async function reset() {
    try {
        await api('/api/admin/cost-rates', { method: 'DELETE' });
        closeModalById('rateModal');
        await renderRateCard();
        document.dispatchEvent(new CustomEvent('ami:rates-changed'));
        flash('ok', 'Token rates reset to defaults.');
    }
    catch (e) {
        setMsg('err', e.message);
    }
}
/** One-time wiring. Called from main's boot. */
export function wireRateEditor() {
    const form = document.getElementById('rateForm');
    form?.addEventListener('submit', ev => {
        ev.preventDefault();
        const input = Number(must('rateInput').value);
        const output = Number(must('rateOutput').value);
        if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) {
            setMsg('err', 'Rates must be zero or greater.');
            return;
        }
        void save(input, output);
    });
    document.getElementById('rateReset')?.addEventListener('click', () => { void reset(); });
    // The Live tab's rate card opens the editor. The card is re-rendered by
    // renderRateCard, so the listener is delegated rather than bound to the node.
    document.addEventListener('click', ev => {
        const t = ev.target;
        if (!t || typeof t.closest !== 'function')
            return;
        if (t.closest('#liveRates'))
            void openRateEditor();
    });
    // Ctrl+Shift+R anywhere. Ignored while a text field has focus so it cannot
    // hijack an ordinary Ctrl+Shift+R in a future input on this page.
    document.addEventListener('keydown', ev => {
        const e = ev;
        if (!e.ctrlKey || !e.shiftKey)
            return;
        if (e.key !== 'R' && e.key !== 'r')
            return;
        const t = e.target;
        if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
            return;
        e.preventDefault();
        void openRateEditor();
    });
    // A rates change anywhere re-renders the Costs tab, whichever one is open.
    document.addEventListener('ami:rates-changed', () => {
        document.dispatchEvent(new CustomEvent('ami:refresh'));
    });
}
//# sourceMappingURL=rates.js.map
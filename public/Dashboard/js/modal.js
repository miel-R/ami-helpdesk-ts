// Shared Bootstrap modal helper (single Modal instance per modal element).
import { must } from './utils.js';
const instances = new Map();
function modalFor(id) {
    let m = instances.get(id);
    if (!m) {
        m = new bootstrap.Modal(must(id));
        instances.set(id, m);
    }
    return m;
}
export function openModal(title, bodyHtml) {
    must('appModalTitle').textContent = title;
    must('appModalBody').innerHTML = bodyHtml;
    modalFor('appModal').show();
}
export function closeModal() {
    instances.get('appModal')?.hide();
}
/**
 * Opens a self-contained modal that manages its own markup.
 *
 * Kept separate from openModal because the rate editor owns a <form> with live
 * inputs. Routing it through appModal would wipe innerHTML on every open, which
 * throws away half-typed values, so this takes the element id and leaves its
 * contents alone.
 */
export function openModalById(id) {
    modalFor(id).show();
}
export function closeModalById(id) {
    instances.get(id)?.hide();
}
//# sourceMappingURL=modal.js.map
// Shared Bootstrap modal helper (single Modal instance for the whole app).
import { must } from './utils';
let modalInstance = null;
export function openModal(title, bodyHtml) {
    must('appModalTitle').textContent = title;
    must('appModalBody').innerHTML = bodyHtml;
    if (!modalInstance)
        modalInstance = new bootstrap.Modal(must('appModal'));
    modalInstance.show();
}
export function closeModal() {
    modalInstance?.hide();
}
//# sourceMappingURL=modal.js.map
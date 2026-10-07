// Shared Bootstrap modal helper (single Modal instance for the whole app).
import { must } from './utils';

declare const bootstrap: { Modal: new (el: Element) => { show(): void; hide(): void } };

let modalInstance: { show(): void; hide(): void } | null = null;

export function openModal(title: string, bodyHtml: string): void {
  must('appModalTitle').textContent = title;
  must('appModalBody').innerHTML = bodyHtml;
  if (!modalInstance) modalInstance = new bootstrap.Modal(must('appModal'));
  modalInstance.show();
}

export function closeModal(): void {
  modalInstance?.hide();
}

// Staging an upload so n8n can find it.
//
// MIS stores attachments on a NAS share. The chatbot cannot write there itself, so
// it stages the file where it can, and hands n8n the path. n8n moves it into place
// and writes the row.
//
// Path safety is the whole job here: the filename comes from the browser, so it is
// sanitised and confined to a per-ticket directory. A shared absolute path would
// be simpler and would let a crafted filename escape the staging tree.

import fs from 'fs';
import path from 'path';
import { config } from '../../config/config.service';
import { logEvent } from '../../core/logger';
const INCOMING_DIR = '_incoming';

/** Absolute path of the staging root, inside the mounted file_master tree. */
export function stagingRoot(): string {
  return path.join(config.paths.attachmentsDir, INCOMING_DIR);
}

/**
 * Reduce an uploaded filename to something safe to write to disk.
 *
 * The original name is deliberately kept, spaces and all: MIS shows these files
 * back to requesters ("Security Report 29-Jun-2026.docx"), and the old intake
 * hashed them, so a uuid name would be visible to users as noise. `#` becomes
 * `-` to match scrf.form.php, and path separators are dropped so a crafted name
 * cannot climb out of the staging folder.
 */
export function sanitizeUploadName(raw: string): string {
  const base = path.basename(String(raw || '').replace(/\\/g, '/')).replace(/#/g, '-');
  const cleaned = base
    // Letters, digits, dot, underscore, space, brackets, apostrophe, comma,
    // hyphen. The punctuation that is allowed matches what the legacy app
    // already has on disk ("Q4 24' PO for IFPD - Copy.xlsx", "Batch 7 NEVA X
    // RMA SN, PROD, BAG ID.xlsx") so requesters see the same filename they
    // would have seen from the old form.
    .replace(/[^A-Za-z0-9._ ()',-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot would produce ".", ".." or a hidden file.
    .replace(/^\.+/, '');
  const safe = cleaned || 'attachment';
  // Leave room for the ticket-key folder and still fit a 255-byte name.
  return safe.length > 180 ? safe.slice(0, 180) : safe;
}

/**
 * Move one multer temp file into its per-submission staging folder.
 *
 * Returns the wire shape n8n needs: the display name to record, and where the
 * bytes are right now so n8n can move them once it has a control number.
 */
export function stageAttachment(file: Express.Multer.File, ticketKey: string): {
  file_name: string;
  staged_path: string;
} {
  const dir = path.join(stagingRoot(), ticketKey);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = sanitizeUploadName(file.originalname);
  const stagedPath = path.join(dir, fileName);
  // rename rather than copy: same filesystem, so it is atomic and leaves no
  // duplicate behind in the multer temp folder.
  fs.renameSync(file.path, stagedPath);
  return { file_name: fileName, staged_path: stagedPath };
}

/** Drop anything multer already wrote, so a rejected ticket leaves no files. */
export function discardUploads(files: unknown): void {
  if (!Array.isArray(files)) return;
  for (const file of files) {
    const p = (file as Express.Multer.File)?.path;
    if (!p) continue;
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
}

/**
 * Multer's destination for ticket uploads.
 *
 * Created lazily, per request, and never at startup. multer({ dest }) runs its
 * mkdir when the module is constructed, so pointing it at the NAS meant the
 * server refused to boot whenever the share was unmounted - and the chat was
 * unavailable because a file share was down.
 *
 * `stagingWritable` is the flag the health of the share is reported through, and
 * is why an unreachable share produces a clear upload error instead of a crash.
 */
let stagingWritable = false;

export function isStagingWritable(): boolean {
  return stagingWritable;
}

/** The upload error a caller should show when the share is unreachable. */
export function stagingUnavailableMessage(): string {
  return 'The file share is not mounted, so this attachment cannot be accepted. Please remove it and try again, or contact MIS directly.'
}

export function stagingDestination(
  _req: Express.Request,
  _file: Express.Multer.File,
  cb: (error: Error | null, destination: string) => void
): void {
  const root = stagingRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!stagingWritable) {
      // Logged once, on the transition. A share that stays down would otherwise
      // log on every single upload for the life of the process.
      stagingWritable = true;
      logEvent('info', 'attachment_staging_available', { root });
    }
    cb(null, root);
  } catch (e) {
    if (stagingWritable) {
      console.warn(`[attachments] staging root unavailable: ${(e as Error).message}`);
    }
    stagingWritable = false;
    logEvent('warn', 'attachment_staging_unavailable', { root, error: (e as Error).message });
    // multer's callback type insists on a destination even on error; the value is
    // ignored when `error` is set, and the empty string keeps the type honest
    // rather than widening it to optional at every call site.
    cb(e as Error, '');
  }
}

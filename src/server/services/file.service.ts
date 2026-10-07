// File Processing
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { analyzeImage } from '../ai';
import { config } from '../config/config.service';
import type { Response } from 'express';
import type { TokenUsage } from '../ai';

/** A multer file, narrowed to the fields this module actually uses. */
export interface UploadedFile {
  originalname?: string;
  path: string;
  size: number;
  mimetype: string;
}

/**
 * Token usage from the vision call, carried up so the ledger can record it.
 *
 * This is the same `TokenUsage` the chat path uses, not a narrower shape: the
 * ledger needs provider/model/totalTokens too, so re-declaring a partial
 * interface here just pushed that error into the caller.
 */
export type AnalysisUsage = TokenUsage;

export interface ProcessedFile {
  error: string | null;
  name: string;
  size: number;
  type: string;
  extracted?: string;
  analysis?: string | null;
  analysisUsage?: AnalysisUsage | null;
  stored_name?: string;
  stored_path?: string;
}

/**
 * Process an uploaded file: size check, extraction, then permanent storage.
 *
 * @param file               multer file
 * @param sessionId          conversation the upload belongs to
 * @param isTicketAttachment true to file under attachments, false under uploads
 * @param maxBytes           per-user ceiling; falls back to config when absent
 */
export async function processFile(
  file: UploadedFile,
  _sessionId: string,
  isTicketAttachment: boolean,
  maxBytes?: number
): Promise<ProcessedFile> {
  const name = file.originalname || 'unknown';
  const tmpName = file.path;
  const size = file.size;
  const mime = file.mimetype;
  const ext = path.extname(name).toLowerCase().slice(1);
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : config.security.maxFileSize;

  if (!fs.existsSync(tmpName)) {
    return { error: 'Invalid file upload', name, size, type: ext };
  }

  if (size > limit) {
    const mb = (limit / (1024 * 1024)).toFixed(limit % (1024 * 1024) ? 1 : 0);
    return { error: `File exceeds the ${mb} MB limit for your account`, name, size, type: ext };
  }

  let result: ProcessedFile = {
    name, size, type: ext, extracted: '', analysis: null, analysisUsage: null, error: null
  };

  if (config.security.allowedImageTypes.includes(ext) || mime.startsWith('image/')) {
    const data = fs.readFileSync(tmpName);
    const base64 = data.toString('base64');
    // analyzeImage returns { text, usage }; the vision call costs real tokens so
    // the usage is carried up for the ledger rather than discarded.
    const vision = await analyzeImage(base64, mime);
    result = {
      ...result,
      type: 'image',
      extracted: `[Image: ${name}]`,
      analysis: vision ? vision.text : null,
      analysisUsage: vision ? vision.usage : null
    };
  } else if (['csv', 'txt'].includes(ext)) {
    const data = fs.readFileSync(tmpName, 'utf8');
    result = { ...result, type: 'csv', extracted: data.slice(0, 5000) };
  } else if (['xlsx', 'xls'].includes(ext)) {
    result = { ...result, type: 'excel', error: 'Excel parsing not implemented in Node version' };
  } else {
    result.error = 'Unsupported file type. Upload an image, CSV, or Excel file.';
  }

  if (result.error) return result;

  // Move to permanent storage.
  const uploadDir = isTicketAttachment ? config.paths.attachmentsDir : config.paths.uploadsDir;
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

  // Strip anything that is not filename-safe before writing to disk.
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_');
  const storedName = `${uuidv4()}_${safeName}`;
  const storedPath = path.join(uploadDir, storedName);
  fs.copyFileSync(tmpName, storedPath);
  fs.unlinkSync(tmpName);

  return { ...result, stored_name: storedName, stored_path: storedPath };
}

/**
 * Serve a stored file by name.
 *
 * path.basename is the important part: it strips any directory component, so a
 * request for "../../../etc/passwd" resolves to "passwd" inside the upload
 * directory instead of escaping it. Returns true when a file was sent.
 */
export function serveFile(name: string, res: Response): boolean {
  const raw = String(name || '');
  const safeName = path.basename(raw);
  const dirs = [config.paths.attachmentsDir, config.paths.uploadsDir];

  for (const dir of dirs) {
    let filePath = path.join(dir, safeName);
    if (!fs.existsSync(filePath)) {
      try {
        // Stored names are prefixed with a uuid, so accept a suffix match for
        // callers holding the original filename.
        const match = fs.readdirSync(dir).find(f => f.endsWith('_' + safeName));
        if (match) filePath = path.join(dir, match);
      } catch {
        /* ignore */
      }
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.sendFile(path.resolve(filePath));
      return true;
    }
  }
  return false;
}

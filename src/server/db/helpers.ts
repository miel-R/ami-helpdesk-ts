// Small helpers both backends use.

import fs from 'fs';
import path from 'path';
import fsp from 'fs/promises';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// Costs are stored to 10 decimal places; a Gemini flash call is a fraction of a
// cent, so rounding to 2dp would flatten most rows to zero.
export function round10(n: unknown): number {
  return Math.round(num(n) * 1e10) / 1e10;
}

export function readJsonSync<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (e) {
    console.error(`[db] could not read ${path.basename(file)}: ${(e as Error).message} - starting fresh`);
  }
  return fallback;
}

// Write to a temp file then rename. rename() is atomic within a filesystem, so a
// crash mid-write can never leave a truncated ledger behind.
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  try {
    await fsp.rename(tmp, file);
  } catch {
    // rename() can fail on Windows when the destination is held open by another
    // handle (antivirus, file indexer, a concurrent reader). copy + unlink is
    // not atomic, but it is far better than losing the write entirely.
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

/** Split a request quota / limit patch value. undefined = leave alone, null = inherit. */
export function limitValue(v: unknown): number | null {
  if (v === null || v === '') return null;
  return Math.max(0, parseInt(String(v), 10) || 0);
}

// Small filesystem helpers used by the storage fallbacks.

import fs from 'fs';

/** Read a JSON file, tolerating a UTF-8 BOM. Returns null on any failure. */
export function readJson<T = unknown>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}
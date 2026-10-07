// Runtime feature flags that survive a restart.
//
// These live in files under the data directory rather than in memory or config,
// so a container restart cannot silently drop a decision an admin made. That
// matters most for webhook debug mode: if it lived in memory and the container
// bounced mid-investigation, tickets would quietly start going to production
// again while the admin still believed they were pointing at the test webhook.

import fs from 'fs';
import path from 'path';
import { config } from '../config/config.service';

const WEBHOOK_DEBUG_FLAG = path.join(config.paths.dataDir, 'webhook_debug');

/**
 * When on, every ticket Ami creates is posted to the n8n TEST webhook.
 *
 * Read by webhook.ts on every submission, so it takes effect immediately with no
 * restart and no chance of a stale in-memory copy disagreeing with the file.
 */
export function isWebhookDebug(): boolean {
  try {
    return fs.existsSync(WEBHOOK_DEBUG_FLAG);
  } catch {
    return false;
  }
}

/** Turn webhook debug mode on or off. Returns false if the flag could not be written. */
export function setWebhookDebug(on: boolean): boolean {
  try {
    if (on) {
      fs.mkdirSync(path.dirname(WEBHOOK_DEBUG_FLAG), { recursive: true });
      fs.writeFileSync(
        WEBHOOK_DEBUG_FLAG,
        new Date().toISOString(),
        'utf8'
      );
    } else if (fs.existsSync(WEBHOOK_DEBUG_FLAG)) {
      fs.unlinkSync(WEBHOOK_DEBUG_FLAG);
    }
    return true;
  } catch {
    return false;
  }
}

/** When debug mode was switched on, for reporting. Null if off or unreadable. */
export function webhookDebugSince(): string | null {
  try {
    if (!fs.existsSync(WEBHOOK_DEBUG_FLAG)) return null;
    const raw = fs.readFileSync(WEBHOOK_DEBUG_FLAG, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

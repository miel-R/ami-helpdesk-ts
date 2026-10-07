// Liveness and readiness.
//
// These are deliberately separate claims. `200` means the process is up AND its
// storage can actually serve the routes below it; `503` means the process is
// running but unusable. This endpoint used to answer "ok" without touching the
// database at all, which is how a total storage outage sat behind a green light.

import type { Application, Request, Response } from 'express';
import { config } from '../config/config.service';
import conversationManager from '../services/session.service';
import { serverStartedAt } from '../core/logger';
import { db, kind as dbKind } from '../db/storage.service';
import type { StorageHealth } from '../db/storage.service';
import { isWebhookDebug } from '../core/flags';

export function registerHealthRoutes(app: Application): void {
  app.get('/api/health', async (req: Request, res: Response) => {

  void req;
  const now = Date.now();
  let activeConversations = 0;
  for (const conv of conversationManager.getAllConversations().values()) {
    if (Number(conv.lastActivity ?? 0) > now - 15 * 60 * 1000) activeConversations++;
  }

  // Never let a failing health check throw: an unhandled rejection here would
  // take down the request instead of reporting the outage.
  let storage: StorageHealth;
  try {
    storage = await db().health();
  } catch (e) {
    storage = { ok: false, missing: [], error: (e as Error).message };
  }

  res.status(storage.ok ? 200 : 503).json({
    status: storage.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '3.0.0',
    uptime_seconds: Math.floor((Date.now() - serverStartedAt) / 1000),
    active_conversations: activeConversations,
    tls: !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE),
    memory_mb: { rss: Math.round(process.memoryUsage().rss / 1024 / 1024), heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) },
    ai_configured: !!(config.gemini.apiKey || config.openai.apiKey),
    webhook_configured: !!config.n8n.webhookUrl,
    webhook_debug: isWebhookDebug(),
    webhook_target: isWebhookDebug() ? 'test' : 'production',
    storage: dbKind(),
    database_configured: !!process.env.DATABASE_URL,
    // The detail matters more than the status code: "which tables are missing"
    // is the difference between a five-minute fix and an afternoon.
    storage_ok: storage.ok,
    storage_missing_tables: storage.missing,
    storage_error: storage.error ?? null,
    storage_conversations: storage.conversations ?? null,
    storage_messages: storage.messages ?? null
  });
});

}

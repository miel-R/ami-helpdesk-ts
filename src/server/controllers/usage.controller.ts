// Cost and token reporting, plus the live configuration the dashboard shows.

import type { Application, Request, Response } from 'express';
import { db, kind as dbKind } from '../db/storage.service';
import { config } from '../config/config.service';
import { isWebhookDebug } from '../core/flags';
import conversationManager from '../services/session.service';
import { requireAdmin, wrap, intQuery } from './admin.shared';

export function registerUsageRoutes(app: Application): void {
  app.get('/api/admin/config', requireAdmin, wrap(async (req: Request, res: Response) => {
    void req;
    res.json({
      storage: dbKind(),
      database_configured: !!process.env.DATABASE_URL,
      defaults: {
        requests_per_day: config.rateLimit.requestsPerDay,
        tickets_per_day: config.rateLimit.perDay,
        max_upload_bytes: config.security.maxFileSize,
        max_history: config.conversation.maxHistory
      },
      pricing: config.pricing,
      model: config.gemini.apiKey ? config.gemini.model : (config.openai.model || null),
      admin_key_set: !!process.env.ADMIN_KEY,
      // Shown on the dashboard so a forgotten debug mode is visible at a glance
      // rather than only in chat.
      webhook_debug: isWebhookDebug(),
      webhook_target: isWebhookDebug() ? 'test' : 'production',
      test_webhook_configured: !!config.n8n.testWebhookUrl
    });
  }));

  /**
   * Token and cost summary, grouped for the dashboard.
   *   ?days=30&username=remiel
   */
  app.get('/api/usage', requireAdmin, wrap(async (req: Request, res: Response) => {
    const days = intQuery(req.query.days, 30, 1, 365);
    const username = req.query.username ? String(req.query.username) : null;
    const summary = await db().summary({ days, username });
    // summary already carries `days`, and it is always the same value the caller
    // asked for, so spreading it last (as the original did) is equivalent to
    // setting it explicitly afterwards.
    res.json({ timestamp: new Date().toISOString(), ...summary, days, username });
  }));

  /**
   * Per-message token ledger.
   *   ?sessionId=...  ?username=...  ?limit=200
   */
  app.get('/api/usage/messages', requireAdmin, wrap(async (req: Request, res: Response) => {
    const rows = await db().listMessages({
      sessionId: req.query.sessionId ? String(req.query.sessionId) : null,
      username: req.query.username ? String(req.query.username) : null,
      limit: intQuery(req.query.limit, 200, 1, 1000)
    });
    res.json({ timestamp: new Date().toISOString(), count: rows.length, messages: rows });
  }));

/**
   * Full per-conversation cost breakdown: the ledger plus the live session.
   */
  app.get('/api/usage/session/:id', requireAdmin, wrap(async (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    const messages = await db().listMessages({ sessionId, limit: 500 });
    const live = conversationManager.getAllConversations().get(sessionId);

    const totals = messages.reduce((a, m) => {
      a.input_tokens += Number(m.input_tokens) || 0;
      a.output_tokens += Number(m.output_tokens) || 0;
      a.total_tokens += Number(m.total_tokens) || 0;
      a.cost_usd += Number(m.cost_usd) || 0;
      a.calls += 1;
      return a;
    }, { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 0, calls: 0 });

    res.json({
      session_id: sessionId,
      user: live?.user || null,
      live: live ? {
        mode: live.mode,
        status: live.status,
        message_count: live.messages.length,
        estimated_cost: Number(live.estimated_cost ?? 0),
        usage: live.usage ?? null,
        last_activity: new Date(live.lastActivity as number).toISOString()
      } : null,
      totals,
      messages
    });
  }));

  /**
   * Users with their effective limits and current usage, so the admin table can
   * show both the override and the value actually in force.
   */
}

// Read-only admin views: the summary counters, the user list, and the request log.
//
// Everything here is GET, and everything here is guarded by requireAdmin.

import type { Application, Request, Response } from 'express';
import { db } from '../db/storage.service';
import { counters, serverStartedAt, getRequestLog } from '../core/logger';
import { config } from '../config/config.service';
import conversationManager from '../services/session.service';
import { requireAdmin, intQuery } from './admin.shared';
import type { SessionUsage } from './admin.shared';

export function registerDashboardRoutes(app: Application): void {
  app.get('/api/stats', requireAdmin, (req: Request, res: Response) => {
    void req;
    const now = Date.now();
    const activeWindow = now - 15 * 60 * 1000;

    // Conversation totals come from STORAGE, not process memory.
    //
    // `getAllConversations()` only holds sessions this process has touched since
    // it started, so the dashboard used to report 10 conversations while the real
    // total was 64 - and every other user's account simply did not appear,
    // because their sessions were in the database and never in this map. That
    // looked like accounts had "disappeared", when they had not.
    db().listConversations({ limit: 500 })
      .then(rows => {
        let activeConversations = 0;
        const byMode: Record<string, number> = {};
        for (const row of rows) {
          const mode = row.mode || 'chat';
          byMode[mode] = (byMode[mode] || 0) + 1;
          const raw = row.last_message_at || row.updated_at || row.created_at;
          const at = raw ? new Date(raw as unknown as string).getTime() : 0;
          if (Number.isFinite(at) && at > activeWindow) activeConversations++;
        }

        // Token and cost totals still come from memory: they are accumulated per
        // live session and are not written back to the conversations table.
        const totals = { prompt: 0, completion: 0, total: 0, calls: 0, cost: 0 };
        for (const conv of conversationManager.getAllConversations().values()) {
          const u = (conv.usage ?? {}) as Partial<SessionUsage>;
          const cost = Number(conv.estimated_cost ?? 0);
          totals.prompt += u.prompt_tokens || 0;
          totals.completion += u.completion_tokens || 0;
          totals.total += u.total_tokens || 0;
          totals.calls += u.calls || 0;
          totals.cost += cost;
        }

        res.json({
          timestamp: new Date().toISOString(),
          uptime_seconds: Math.floor((now - serverStartedAt) / 1000),
          counters: {
            total_requests: counters.totalRequests,
            chat_requests: counters.chatRequests,
            errors: counters.errors,
            ai_calls: counters.aiCalls,
            ai_errors: counters.aiErrors,
            ai_ms_total: counters.aiMsTotal,
            avg_ai_ms: counters.aiCalls ? Math.round(counters.aiMsTotal / counters.aiCalls) : 0,
            uploads: counters.uploads,
            upload_bytes: counters.uploadBytes,
            tickets_created: counters.ticketsCreated,
            tickets_failed: counters.ticketsFailed
          },
          conversations: {
            total: rows.length,
            active_15min: activeConversations,
            by_mode: byMode
          },
          users: {
            tracked: conversationManager.getUserRateLimits().size,
            rate_limit_per_day: config.rateLimit.perDay
          },
          tokens: {
            prompt: totals.prompt,
            completion: totals.completion,
            total: totals.total,
            calls: totals.calls,
            estimated_cost_usd: Number(totals.cost.toFixed(6))
          }
        });
      })
      .catch((e: Error) => res.status(500).json({ error: e.message }));
  });

/**
   * Get all users, with their live sessions and token spend.
   */
  app.get('/api/users', requireAdmin, (req: Request, res: Response) => {
    void req;
    const now = Date.now();
    const userRateLimits = conversationManager.getUserRateLimits();

    const rows: Array<Record<string, unknown>> = [];
    for (const [name, limit] of userRateLimits.entries()) {
      const sess = [...conversationManager.getAllConversations().entries()]
        .filter(([, c]: [string, import('../models/types.model').Conversation]) => (c.user?.first_name || c.user?.user_name) === name)
        .map(([id, c]: [string, import('../models/types.model').Conversation]) => ({
          session_id: id,
          mode: c.mode,
          messages: c.messages.length,
          attachments: c.attachments?.length || 0,
          tokens: (c.usage as Partial<SessionUsage> | undefined)?.total_tokens || 0,
          ai_calls: (c.usage as Partial<SessionUsage> | undefined)?.calls || 0,
          last_activity: new Date(c.lastActivity as number).toISOString(),
          idle_seconds: Math.floor((now - (c.lastActivity as number)) / 1000)
        }));
      const userTotal = sess.reduce((a, s) => a + (s.tokens as number), 0);
      rows.push({
        user: name,
        tickets_today: limit.count,
        quota: config.rateLimit.perDay,
        tokens_total: userTotal,
        window_start: new Date(limit.windowStart).toISOString(),
        sessions: sess
      });
    }
    rows.sort((a, b) => Number(b.tokens_total) - Number(a.tokens_total));
    res.json({ timestamp: new Date().toISOString(), count: rows.length, users: rows });
  });

  /**
   * Get all conversations.
   *
   * Sourced from the database so the list survives a restart, not just the
   * conversations currently held in process memory.
   */
  app.get('/api/logs', requireAdmin, (req: Request, res: Response) => {
    const limit = intQuery(req.query.limit, 100, 1, 500);
    const level = req.query.level || '';
    let logs = getRequestLog().slice(-limit).reverse();
    if (level) logs = logs.filter(l => l.level === level);
    res.json({ timestamp: new Date().toISOString(), total: logs.length, logs });
  });

/**
   * Get conversation history (admin).
   *
   * Newest-first page, keyed on the monotonic message id as a cursor: pass
   * `before` to walk further back. The widget requests 10 at a time and grows
   * the thread on demand, so a long conversation never ships in one payload.
   */

  /**
   * Get detailed system health metrics for PostgreSQL and Chatbot.
   */
  app.get('/api/system/health', requireAdmin, (req: Request, res: Response) => {
    void req;

    // Chatbot metrics from conversation manager
    let activeSessions = 0;
    let totalMessages = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let totalCalls = 0;

    for (const conv of conversationManager.getAllConversations().values()) {
      if (conv.status === 'active') activeSessions++;
      totalMessages += conv.messages?.length || 0;
      const u = conv.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; calls?: number } | undefined;
      if (u) {
        totalTokens += u.total_tokens || 0;
        totalCalls += u.calls || 0;
        totalCost += Number(conv.estimated_cost ?? 0);
      }
    }

    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Calculate CPU percentage (approximate)
    const cpuPercent = (cpuUsage.user + cpuUsage.system) / 1000000; // convert to seconds

    res.json({
      timestamp: new Date().toISOString(),
      postgresql: {
        status: 'connected',
        cpu_usage: 'N/A',
        memory_usage: 'N/A',
        storage_size: 'N/A',
        storage_used: 'N/A',
        connections: 'N/A'
      },
      chatbot: {
        cpu_usage: Math.round(cpuPercent * 100) / 100,
        memory_usage: Math.round(memUsage.heapUsed / 1024 / 1024),
        memory_rss: Math.round(memUsage.rss / 1024 / 1024),
        heap_used: Math.round(memUsage.heapUsed / 1024 / 1024),
        heap_total: Math.round(memUsage.heapTotal / 1024 / 1024),
        active_sessions: activeSessions,
        total_messages: totalMessages,
        total_tokens: totalTokens,
        total_calls: totalCalls,
        estimated_cost_usd: Number(totalCost.toFixed(6)),
        uptime_seconds: Math.floor((Date.now() - serverStartedAt) / 1000)
      },
      node: {
        pid: process.pid,
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        uptime_seconds: Math.floor(process.uptime())
      }
    });
  });

}

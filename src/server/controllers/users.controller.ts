// Creating and editing users: role, enable/disable, and per-user limits.
//
// Separate from the read-only dashboard views because these are the routes that WRITE,
// and they are the ones that decide who may use the bot at all.

import type { Application, Request, Response } from 'express';
import { db, kind as dbKind } from '../db/storage.service';
import { config } from '../config/config.service';
import { logEvent } from '../core/logger';
import type { UserPatch } from '../db/storage.service';
import { requireAdmin, wrap, intQuery } from './admin.shared';
import {
  getTicketModals, saveTicketModalSetting, invalidateTicketModals,
  getLinksOnlyMode, saveLinksOnlyMode
} from '../config/ticket-modals.service';
import { TICKET_TYPES, TICKET_TYPE_LABELS } from '../db/types.model';

export function registerUserAdminRoutes(app: Application): void {
  app.get('/api/admin/users', requireAdmin, wrap(async (req: Request, res: Response) => {
    const users = await db().listUsers();
    const days = intQuery(req.query.days, 30, 1, 365);
    const summary = await db().summary({ days });

    const byUser = new Map(summary.byUser.map(u => [String(u.k), u]));
    const day = new Date().toISOString().slice(0, 10);

    const rows: Array<Record<string, unknown>> = [];
    for (const u of users) {
      const usage = byUser.get(u.username)
        || { input: 0, output: 0, cost: 0, calls: 0 };
      const requestsToday = await db().getRequestUsage(u.username, day);
      const effectiveRequests = u.role === 'admin'
        ? null
        : (u.requests_per_day ?? config.rateLimit.requestsPerDay);
      rows.push({
        username: u.username,
        display_name: u.display_name || u.username,
        email: u.email || '',
        department: u.department || '',
        role: u.role || 'user',
        enabled: u.enabled !== false,
        note: u.note || '',
        // null override = inherit the server default
        requests_per_day: u.requests_per_day ?? null,
        requests_per_day_effective: effectiveRequests,
        requests_inherits: u.requests_per_day === null || u.requests_per_day === undefined,
        max_upload_bytes: u.max_upload_bytes ?? null,
        max_upload_bytes_effective: u.max_upload_bytes ?? config.security.maxFileSize,
        max_upload_inherits: u.max_upload_bytes === null || u.max_upload_bytes === undefined,
        requests_today: requestsToday,
        requests_remaining: effectiveRequests === null ? null : Math.max(0, effectiveRequests - requestsToday),
        tokens_input: usage.input,
        tokens_output: usage.output,
        // The grouped rows carry input/output, never a `total` column, so this
        // is derived rather than read. The original read `usage.total`, which
        // was always undefined and rendered as "NaN" on the dashboard.
        tokens_total: usage.input + usage.output,
        ai_calls: usage.calls,
        cost_usd: Number(usage.cost || 0),
        last_seen: u.last_seen || null,
        created_at: u.created_at || null
      });
    }

    rows.sort((a, b) => Number(b.cost_usd) - Number(a.cost_usd));
    res.json({
      timestamp: new Date().toISOString(), days, storage: dbKind(),
      defaults: {
        requests_per_day: config.rateLimit.requestsPerDay,
        tickets_per_day: config.rateLimit.perDay,
        max_upload_bytes: config.security.maxFileSize
      },
      count: rows.length, users: rows
    });
  }));

/**
   * Update a user's admin-controlled settings.
   * Body: { role, enabled, requests_per_day, max_upload_bytes, note }
   * Passing null for a limit clears the override and restores inheritance.
   */
  app.patch('/api/admin/users/:username', requireAdmin, wrap(async (req: Request, res: Response) => {
    const username = String(req.params.username);
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (body.role && !['user', 'admin'].includes(String(body.role))) {
      res.status(400).json({ error: 'role must be "user" or "admin"' });
      return;
    }
    for (const field of ['requests_per_day', 'max_upload_bytes']) {
      if (field in body && body[field] !== null && body[field] !== '') {
        const n = Number(body[field]);
        if (!Number.isFinite(n) || n < 0) {
          res.status(400).json({ error: `${field} must be a non-negative number or null` });
          return;
        }
      }
    }

    const existing = await db().getUser(username);
    if (!existing) {
      res.status(404).json({ error: `User "${username}" not found` });
      return;
    }

    // Build the patch from only the fields actually present in the body.
    // undefined means "leave alone"; null means "clear the override".
    const patch: UserPatch = {};
    if (body.role !== undefined) patch.role = String(body.role);
    if (body.enabled !== undefined) patch.enabled = !!body.enabled;
    if ('requests_per_day' in body) patch.requests_per_day = body.requests_per_day as number | null;
    if ('max_upload_bytes' in body) patch.max_upload_bytes = body.max_upload_bytes as number | null;
    if ('note' in body) patch.note = body.note === null ? null : String(body.note);

    const updated = await db().updateUser(username, patch);
    if (!updated) {
      res.status(500).json({ error: 'Update failed' });
      return;
    }

    logEvent('info', 'admin_user_update', {
      username,
      role: updated.role,
      enabled: updated.enabled,
      requests_per_day: updated.requests_per_day,
      max_upload_bytes: updated.max_upload_bytes
    });

    res.json({ ok: true, user: updated });
  }));

  app.delete('/api/admin/users/:username', requireAdmin, wrap(async (req: Request, res: Response) => {
    const username = String(req.params.username);
    const existing = await db().getUser(username);
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    await db().deleteUser(username);
    logEvent('info', 'admin_user_delete', { username });
    res.json({ ok: true });
  }));

  /**
   * Create a user record up front, e.g. to pre-grant a higher cap before the
   * person has ever opened the chat.
   */
  app.post('/api/admin/users', requireAdmin, wrap(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = String(body.username || '').trim();
    if (!username) { res.status(400).json({ error: 'username required' }); return; }
    if (await db().getUser(username)) {
      res.status(409).json({ error: `User "${username}" already exists` });
      return;
    }
    const user = await db().ensureUser({
      username,
      displayName: String(body.display_name || username),
      email: String(body.email || ''),
      department: String(body.department || '')
    });
    if (body.role || body.enabled !== undefined || 'requests_per_day' in body || 'max_upload_bytes' in body || body.note) {
      await db().updateUser(username, {
        role: body.role === undefined ? undefined : String(body.role),
        enabled: body.enabled as boolean | undefined,
        requests_per_day: body.requests_per_day as number | null,
        max_upload_bytes: body.max_upload_bytes as number | null,
        note: body.note === undefined ? undefined : String(body.note)
      });
    }
res.status(201).json({ ok: true, user: await db().getUser(username) || user });
  }));

  // -- ticket modal switches ------------------------------------------------

  app.get('/api/admin/ticket-modals', requireAdmin, wrap(async (_req: Request, res: Response) => {
    const settings = await getTicketModals();
    res.json({
      timestamp: new Date().toISOString(),
      links_only: await getLinksOnlyMode(),
      ticket_modals: Object.entries(settings).map(([type, v]) => ({
        ticket_type: type,
        label: TICKET_TYPE_LABELS[type] || type,
        enabled: v.enabled,
        external_url: v.external_url
      }))
    });
  }));

  /**
   * PUT /api/admin/ticket-modals/links-only
   *
   * Its own route rather than a PATCH on the type map, because this is not a
   * ticket type and reusing the type path would let `_links_only` be written
   * through code that validates types.
   */
  app.put('/api/admin/ticket-modals/links-only', requireAdmin, wrap(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.enabled !== 'boolean') {
      res.status(400).json({ error: 'Send { "enabled": true|false }.' });
      return;
    }
    const saved = await saveLinksOnlyMode(body.enabled);
    logEvent('info', 'ticket_modals_links_only', { links_only: saved });
    res.json({ ok: true, links_only: saved });
  }));

  /**
   * PATCH /api/admin/ticket-modals/:type
   *
   * The type is checked against the known list rather than passed to SQL, because
   * an unknown value would otherwise create a row nothing ever reads.
   *
   * The URL is validated here, at the one boundary where the person who made the
   * mistake is still reading the response. It is NOT re-validated in the widget
   * beyond checking the scheme, because by then the person has gone.
   */
  app.patch('/api/admin/ticket-modals/:type', requireAdmin, wrap(async (req: Request, res: Response) => {
    const type = String(req.params.type || '');
    if (!(TICKET_TYPES as readonly string[]).includes(type)) {
      res.status(404).json({ error: `Unknown ticket type "${type}".` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = (await getTicketModals())[type] || { enabled: true, external_url: null };

    const enabled = body.enabled === undefined ? current.enabled : !!body.enabled;
    let externalUrl = current.external_url;
    if ('external_url' in body) {
      const raw = body.external_url === null || body.external_url === '' ? null : String(body.external_url);
      if (raw === null) {
        externalUrl = null;
      } else {
        let parsed: URL | null = null;
        try { parsed = new URL(raw); } catch { parsed = null; }
        // http(s) only. A javascript: or data: URL stored here becomes an href
        // in every user's chat, which makes this table an injection point.
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          res.status(400).json({
            error: 'The link must be a full http:// or https:// address.',
            ticket_type: type
          });
          return;
        }
        // Stored exactly as typed - no normalising the trailing slash or the host
        // case. An admin who typed a URL expects that URL to be the one that opens.
        externalUrl = raw;
      }
    }

    if (enabled === false && !externalUrl) {
      // Allowed, but said out loud in the response so the dashboard can warn:
      // a disabled type with no link is a request nobody can file.
      logEvent('info', 'ticket_modal_disabled_without_link', { type });
    }

    const saved = await saveTicketModalSetting(type, enabled, externalUrl);
    invalidateTicketModals();
    logEvent('info', 'ticket_modal_updated', { type, enabled, has_link: !!externalUrl });
    res.json({ ok: true, ticket_modal: saved });
  }));
}

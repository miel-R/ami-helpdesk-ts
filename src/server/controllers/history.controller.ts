// Reading a conversation back: the list, one thread, and a single page of it.
//
// /api/history/:id is what the widget calls on every boot, so it decides two things
// that used to be decided all over the place: whether an idle session has expired (this
// is normally the first request that notices) and whether the greeting is due.

import type { Application, Request, Response } from 'express';
import conversationManager from '../services/session.service';
import { config } from '../config/config.service';
import { db } from '../db/storage.service';
import { expireIfIdle } from '../services/session-lifecycle.service';
import { greetingFor, greetingPeriod } from '../features/agent/greeting';
import { shouldGreet as shouldGreetFor } from '../features/agent/escalation';
import { getRequestLog } from '../core/logger';
import { intQuery, requireAdmin } from './admin.shared';
import type { SessionUsage } from './admin.shared';

export function registerHistoryRoutes(app: Application): void {
  app.get('/api/conversations', requireAdmin, (req: Request, res: Response) => {
    db().listConversations({ limit: intQuery(req.query.limit, 100, 1, 500) })
      .then(list => {
        const rows = list.map(c => {
          const state = (c.state ?? {}) as Record<string, unknown>;
          const u = (state.usage ?? {}) as Partial<SessionUsage>;
          const user = (state.user ?? {}) as { user_name?: string; email?: string; department?: string };
          return {
            session_id: c.session_id,
            user: c.username || user.user_name || 'unknown',
            email: user.email || '',
            department: user.department || '',
            mode: c.mode,
            status: c.status,
            messages: c.message_count || 0,
            attachments: ((state.attachments ?? []) as unknown[]).length,
            ticket_type: (state.ticket_type as string | undefined) || null,
            control_number: c.control_number || null,
            tokens: {
              prompt: u.prompt_tokens || 0,
              completion: u.completion_tokens || 0,
              total: u.total_tokens || 0,
              calls: u.calls || 0
            },
            estimated_cost_usd: Number((Number(state.estimated_cost ?? 0)).toFixed(6)),
            created_at: c.created_at,
            last_activity: c.last_message_at || c.updated_at
          };
        });
        res.json({ timestamp: new Date().toISOString(), count: rows.length, conversations: rows });
      })
      .catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  /**
   * Get single conversation.
   */
  app.get('/api/conversations/:id', requireAdmin, (req: Request, res: Response) => {
    const id = String(req.params.id);
    // Prefer the live in-memory copy (richest state) and fall back to storage.
    const conv = conversationManager.getAllConversations().get(id);
    const limit = intQuery(req.query.limit, 50, 1, 200);
    Promise.all([
      db().getConversationState(id),
      db().recentMessages(id, limit)
    ]).then(([meta, messages]) => {
      if (!conv && !meta) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      const state = (meta?.state ?? {}) as Record<string, unknown>;
      const stateUser = (state.user ?? {}) as Record<string, unknown>;
      res.json({
        session_id: id,
        user: conv?.user || stateUser || { user_name: meta?.username || '' },
        mode: meta?.mode || conv?.mode || 'chat',
        status: meta?.status || conv?.status || 'active',
        ticket_type: (state.ticket_type as string | undefined) || null,
        collected_fields: state.collected_fields || {},
        attachments: state.attachments || [],
        control_number: meta?.control_number || null,
        usage: Object.assign({}, state.usage || {}, {
          estimated_cost_usd: Number(Number(state.estimated_cost ?? 0).toFixed(6))
        }),
        messages
      });
    }).catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  /**
   * Get logs.
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
  app.post('/api/chat/history', requireAdmin, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = body.session_id;
    const before = (body.before ?? null) as string | number | null;
    const limit = intQuery(body.limit, 10, 1, 100);
    if (!sessionId) { res.status(400).json({ error: 'session_id required' }); return; }
    db().pageMessages(String(sessionId), { limit, before })
      .then(page => res.json({ session_id: sessionId, ...page }))
      .catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  /**
   * Public history endpoint.
   *
   * Note: the session id is the MIS login id, and this route is unauthenticated
   * because the widget is served cross-origin from a page on another host and
   * cannot present the PHP session cookie. The chatbot only accepts a request
   * that also carries a login_user, but this read path is still reachable by
   * anyone who can guess an id. See the deployment notes.
   */
  app.get('/api/history/:id', (req: Request, res: Response) => {
    const limit = intQuery(req.query.limit, 50, 1, 100);
    const before = (req.query.before || null) as string | number | null;
    Promise.all([
      db().pageMessages(String(req.params.id), { limit, before }),
      db().getConversationState(String(req.params.id))
    ]).then(async ([page, meta]) => {
      const state = (meta?.state ?? {}) as Record<string, unknown>;
      const person = (state.user ?? {}) as { user_name?: string; first_name?: string };
      const openName = String(person.first_name || person.user_name || '').trim();
      // This is the call that matters for expiry. The user is normally away when
      // a session times out, so reopening the widget is the first moment the
      // server finds out - waiting for their next message meant the farewell
      // arrived after they had already started a new conversation.
      //
      const sessionId = String(req.params.id);
      // Always adopt the conversation, INCLUDING for an id storage has never seen.
      //
      // Refusing to create an entry for unknown ids was tried here, on the theory
      // that this route is unauthenticated and a loop over random ids would grow
      // the cache. It broke the greeting instead: a brand-new session IS an id
      // storage has never seen, and the greeting claim has to be made
      // synchronously on this object ("two history loads in the same tick would
      // both greet"). With no object to claim, all three concurrent loads greeted.
      //
      // The memory growth is real but it is not this line's job: `evictIdle` in
      // the idle sweep releases anything finished, which is the actual fix, and it
      // releases real sessions too. The rate limiter above bounds how fast new
      // ids can be introduced in the first place.
      const live = conversationManager.getConversation(sessionId, { peek: true });
      const storedSeen = Number((state.last_seen as number | undefined) ?? 0);
      // Both come from storage, not from `live`: on a cold process that object
      // is still empty because the restore is asynchronous.
      // "Did this session have anything worth closing?" comes from the paged result:
      // it is newest-first with a limit, so it is non-empty exactly when the
      // session has any messages at all.
      //
      // Not from the live conversation either - on a cold process that object is
      // still empty because the restore is asynchronous, which made every
      // returning session look untouched and none of them ever expired.
      const storedHasContent = page.messages.length > 0
        || (meta?.mode ?? 'chat') !== 'chat'
        || Object.keys((state.collected_fields ?? {}) as Record<string, unknown>).length > 0;
      // Nothing to expire for an unknown id.
      const justExpired = live
        ? expireIfIdle(sessionId, live, storedSeen || undefined, storedHasContent)
        : false;
      // Awaited: this endpoint is where a session is found to have expired, so
      // the write has to land before the response claims the session is closed.
      // Otherwise a reload arriving mid-write sees it still open.
      if (justExpired && live) await conversationManager.saveConversation(sessionId);

      // Determine if we should send a greeting (only for truly new sessions).
      // The live conversation matters as much as the stored state: the widget
      // loads history more than once on boot, and the persisted flag may not be
      // on disk yet when the next request arrives.
      const shouldGreet = shouldGreetFor({
        messageCount: page.messages.length,
        storedGreeted: state.greeted === true,
        liveGreeted: (live as unknown as { greeted?: boolean } | null)?.greeted === true
      });

      // If sending a greeting, mark the session as greeted so it won't be sent again
      if (shouldGreet) {
        // Claim it on the live conversation FIRST and synchronously. Two history
        // loads landing in the same tick would otherwise both see
        // `shouldGreet === true` and both render the greeting.
        if (live) (live as unknown as { greeted?: boolean }).greeted = true;

        const updatedState = { ...state, greeted: true };
        // Preserve the existing meta (mode, status, uploads) from the conversation.
        const metaForSave: Record<string, unknown> = {
          mode: meta?.mode || 'chat',
          status: meta?.status || 'active',
          controlNumber: meta?.control_number || null,
          uploads: meta?.uploads || [],
          username: meta?.username || ''
        };
        // Awaited, not fire-and-forget: if the write does not land before the
        // response goes out, the very next history load greets the user again.
        await db().saveConversationState(String(req.params.id), updatedState, metaForSave);
      }

      res.json({
        messages: page.messages,
        has_more: page.has_more,
        next_before: page.next_before,
        mode: meta?.mode || 'chat',
        uploads: meta?.uploads || [],
        status: meta?.status || 'active',
        control_number: meta?.control_number || null,
        // Lets the widget retire a stale "Session ended" marker after the user
        // has been idle. Single source of truth lives in SESSION_TIMEOUT.
        session_idle_ms: config.conversation.sessionTimeout,
        // Milliseconds until the session expires due to inactivity.
        // The client uses this to arm its timer with the true remaining time,
        // so a refresh at minute 4 doesn't hand out a fresh 5 minutes.
        //
        // Measured from `storedSeen`, NOT from the live conversation. Peeking
        // leaves `live` alone, but on a cold process that object was only just
        // created and its `last_seen` reads "now", so a session that expired an
        // hour ago reported a full five minutes remaining and the widget armed
        // its own timer from that lie - it then sat there for another five
        // minutes instead of drawing the boundary the server had already
        // persisted. `storedSeen` is the value storage actually holds.
        //
        // A missing timestamp falls back to the live one so a brand-new session
        // still reports a full period rather than expiring instantly.
        idle_remaining_ms: Math.max(
          0,
          config.conversation.sessionTimeout
            - (Date.now() - (storedSeen || Number(live?.last_seen) || Date.now()))
        ),
        // When to check if the user is still there. Shorter than the end of the
        nudge_ms: config.conversation.nudgeAfter,
        // The widget never calls /api/session - it boots from history - so the
        // opening lines have to ride along here or they are never seen.
        //
        // `goodbye` is READ, not cleared: this is a GET, and consuming the
        // message as a side effect of looking would lose it if the response
        // failed to render. It is cleared when the user next actually sends.
        // READ from the live conversation, not from `state`: expiry may have just
        // queued the farewell, and `state` was read before that happened.
        // (The GET still does not CONSUME it - that happens when the user next
        // actually sends something.)
        // Optional-chained throughout: `live` is null for an id storage has never
        // heard of, and a brand-new session is exactly that case. Reading
        // `live.pending_goodbye` unguarded threw a TypeError, which the route's
        // catch turned into a 500 - so the very first history load of every new
        // user failed, and with it the greeting. The stored value covers the same
        // ground for any session that does exist.
        goodbye: (((live as unknown as { pending_goodbye?: string | null } | null)?.pending_goodbye)
          || (state.pending_goodbye as string | undefined) || null),
        session_ended: !!((live as unknown as { pending_goodbye?: string | null } | null)?.pending_goodbye
          || state.pending_goodbye),
        // Only send greeting for genuinely new sessions (no messages, not greeted yet).
        // The widget shows this greeting only when the thread is empty, so we must
        // not send it for returning sessions or it will appear on every history load.
        greeting_period: greetingPeriod(config.timezone),
        greeting: shouldGreet ? greetingFor(openName, config.timezone) : null,
        // So a reload can repeat the confirmation instead of dropping the user
        // into an apparently empty thread. Read from the live conversation as
        // well as storage: the ticket route sets it in memory and saves
        // asynchronously, so a reload can beat that write to disk.
        // Optional-chained for the same reason as `goodbye` above: `live` is null
        // for an id storage has never seen, and this route serves those too.
        last_control_number: (live as unknown as { last_control_number?: string } | null)?.last_control_number
          || meta?.control_number || null
          || String(state.last_control_number || '')
          || String(meta?.control_number || '')
          || null
      });
    }).catch((e: Error) => res.status(500).json({ error: e.message }));
  });

  // NOTE: /api/files/:name is deliberately NOT registered here.
  //
  // The original had this route in BOTH admin.js and main.js. Express matches
  // the first registration, and registerAdminRoutes() runs before main.ts gets
  // to its own copy, so the version below used to win - and that copy hardcodes
  // the container paths /app/data/*. Outside Docker those directories do not
  // exist, so every file the widget tried to show came back 404 even though the
  // file was sitting in the configured uploadsDir. The route in main.ts uses
  // file.serveFile(), which reads config.paths and therefore works in both.

  // ==========================================================================
  // Usage, cost and per-user controls
  // ==========================================================================

  /**
   * Storage backend and the server-wide defaults that per-user overrides
   * inherit from, so the UI can show "inherited" values accurately.
   */
}

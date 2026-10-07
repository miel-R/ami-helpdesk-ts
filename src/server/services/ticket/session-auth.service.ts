// Who is filing this ticket.
//
// The ticket route authenticates on the stored conversation, not on anything the
// request asserts. A client that posts its own `user` object would otherwise be
// able to file a ticket in someone else's name, so the login comes from the
// session the chatbot already established.
//
// The identity that ends up on the ticket is then enriched from MIS, which is
// where the authoritative name and employee number live.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logEvent } from '../../core/logger';
import type { SessionUser } from '../../models/types.model';
import { db } from '../../db/storage.service';
export interface ResolvedSession {
  sessionId: string;
  loginId: string;
  user: SessionUser;
  displayName: string;
}

/**
 * Resolve who is calling from the session the server already knows about.
 *
 * The widget is embedded cross-origin and cannot present a cookie, so it sends
 * `X-Session-ID`. That id is looked up against the conversation the server
 * itself recorded, and the login behind it is read back out of our own user
 * table. Nothing about the caller is taken from the request body: a client that
 * posts its own `user` object can otherwise file tickets in someone else's name.
 */
export async function resolveSession(req: Request): Promise<ResolvedSession | null> {
  const header = req.headers['x-session-id'];
  const sessionId = String(Array.isArray(header) ? header[0] : header || '').trim()
    || String((req.body as Record<string, unknown> | undefined)?.session_id || '').trim();
  if (!sessionId) return null;

  // The MIS catalog behind these routes is authoritative; the chatbot's own
  // Postgres storage is not. Reading the identity from a conversation row meant
  // every dropdown failed until that row existed, so a fresh session - or a
  // database that had not been initialised yet - showed three empty forms even
  // though MIS answered instantly. The widget's session id IS the MIS login, so
  // the login falls back to the users table and only needs the conversation row
  // as a nicety.
    const stored = await db().getConversationState(sessionId);
    const state = (stored?.state ?? {}) as {
      user?: { user_name?: string; login?: string; email?: string; department?: string; mis_user_id?: string };
    };

    // The login is `state.user.login`, NOT `state.user.user_name`.
    //
    // `user_name` holds the DISPLAY name ("Remiel Baking"), and the users table
    // is keyed by login ("remiel.baking"). Looking up `user_name` therefore found
    // no row, so displayName fell back to the display name and email, department
    // and mis_user_id all came out empty - which is why MIS received every ticket
    // with a blank requester name, a blank e-mail and requester id 0, even though
    // the values were sitting in the conversation state the whole time.
    //
    // `sessionId` is the login too (the widget keys history on loginUser), so it
    // stays the final fallback.
    const loginId = String(state?.user?.login || '').trim() || sessionId;

    const record = await db().getUser(loginId);
    if (record && record.enabled === false) return null;
    // A login we have never seen, and no conversation vouching for it, is not
    // enough to read MIS data.
    if (!record && !state?.user?.login && !state?.user?.user_name) return null;

    // Prefer the users record, but fall back to what the conversation already
    // vouched for. `mis_user_id` is the MIS employee number the ticket is filed
    // against and only ever exists on the conversation, so without this it is
    // lost and `scrf_user_id` lands as 0.
    const displayName = String(record?.display_name || state?.user?.user_name || loginId).trim();
    const parts = displayName.split(/\s+/).filter(Boolean);

    const user: SessionUser = {
      user_name: loginId,
      first_name: parts[0] || '',
      last_name: parts.slice(1).join(' '),
      email: String(record?.email || state?.user?.email || ''),
      department: String(record?.department || state?.user?.department || ''),
      role: record?.role === 'admin' ? 'admin' : 'user',
      // The MIS employee number the ticket is filed against. It exists ONLY on the
      // conversation - the users table has no such column - so it is read from
      // there and nowhere else. Left blank rather than guessed: a wrong employee
      // number files the ticket against the wrong person.
      mis_user_id: String(state?.user?.mis_user_id || '')
    };

    return { sessionId, loginId, user, displayName };
}

export function requireSession(): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resolved = await resolveSession(req);
      if (!resolved) {
        res.status(401).json({ ok: false, error: 'Not authenticated' });
        return;
      }
      (req as Request & { amiSession?: ResolvedSession }).amiSession = resolved;
      next();
    } catch (e) {
      logEvent('error', 'ticket_auth_error', { error: (e as Error).message });
      res.status(500).json({ ok: false, error: 'Could not verify the session' });
    }
  };
}
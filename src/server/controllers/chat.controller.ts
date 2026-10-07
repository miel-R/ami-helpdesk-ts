// The chat endpoints: /api/session (bootstrap) and /api/chat (a turn).
//
// This file is only the HTTP layer. /api/session is short enough to read in one
// go, and /api/chat is seven stages that live in services/chat - the turn is a
// sequence of decisions, and it is described there rather than here.
//
// What stays is the part that is genuinely about HTTP: parsing the request,
// turning a stage result into a response, and refusing to swallow an error that
// has already started being sent.

import type { Application, Request, Response } from 'express';

import { counters, logEvent } from '../core/logger';
import { db } from '../db/storage.service';
import { config } from '../config/config.service';
import conversationManager from '../services/session.service';
import { greetingFor } from '../features/agent/greeting';
import {
  CHAT_STAGES, runChatPipeline, contextFromRequest, NO_IDENTITY_MESSAGE
} from '../services/chat';

// Multer's own type, so a wrong storage configuration is a compile error here
// rather than a runtime surprise on the first upload.
type FileUpload = ReturnType<typeof import('multer')>;

export function registerChatRoutes(app: Application, upload: FileUpload): void {

  app.post('/api/session', upload.none(), async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const {
      session_id, login_user, user_name, user_email,
      user_department, identity_token
    } = body;

    const loginId = String(login_user ?? '').trim();
    if (!loginId) {
      res.status(401).json({ error: NO_IDENTITY_MESSAGE, code: 'no_identity' });
      return;
    }
    const sessionId = String(session_id);
    const conversation = conversationManager.getConversation(sessionId);
    const bag = conversation as unknown as { pending_goodbye?: string | null; greeted?: boolean };
    let greeting: string | null = null;
    let goodbye: string | null = null;

    try {
      await db().ensureUser({
        username: loginId,
        displayName: String(user_name ?? ''),
        email: String(user_email ?? ''),
        department: String(user_department ?? '')
      });
    } catch (e) {
      console.warn(`[session] ensureUser failed for ${loginId}: ${(e as Error).message}`);
    }

    if (String(user_name ?? '').trim()) {
      const parts = String(user_name).trim().split(/\s+/).filter(Boolean);
      conversation.user = {
        ...conversation.user,
        user_name: loginId,
        email: String(user_email ?? ''),
        department: String(user_department ?? '') || 'MIS',
        first_name: parts[0] || 'User',
        last_name: parts.slice(1).join(' ')
      };
    }

    const name = String(user_name ?? '').split(/\s+/).filter(Boolean)[0] || '';

    // Awaited: the greeting flag and the farewell marker are the two things
    // most obviously lost across a restart when the write was fire-and-forget,
    // and a lost `greeted` flag means the user is greeted again every reload.
    if (bag.pending_goodbye) {
      goodbye = bag.pending_goodbye;
      bag.pending_goodbye = null;
      await conversationManager.saveConversation(sessionId);
    } else if (!bag.greeted) {
      greeting = greetingFor(name, config.timezone);
      bag.greeted = true;
      await conversationManager.saveConversation(sessionId);
    }

    res.json({
      session_id: sessionId,
      user: {
        user_name: loginId,
        first_name: String(user_name ?? '').split(/\s+/).filter(Boolean)[0] || 'User',
        email: String(user_email ?? ''),
        department: String(user_department ?? '') || 'MIS'
      },
      // Deliberately NOT reported: is_admin. The role is resolved server-side
      // on every chat turn from the signed identity token, never from anything
      // this endpoint echoes back, so a tampered value here cannot grant access.
      authenticated: true,
      identity_token_present: !!String(identity_token ?? '').trim(),
      session_idle_ms: config.conversation.sessionTimeout,
      greeting,
      goodbye
    });
  } catch (e) {
    console.error('[session] failed:', e);
    res.status(500).json({ error: 'Could not start the chat session.' });
  }
});

  app.post('/api/chat', upload.array('files'), async (req: Request, res: Response) => {
    try {
      const result = await runChatPipeline(contextFromRequest(req), CHAT_STAGES);
      if (!result) {
        // Every stage either answers or carries on. Falling off the end means a
        // stage was added to the order and forgot to produce a response.
        logEvent('error', 'chat_no_result', { session_id: req.body && req.body.session_id });
        res.status(500).json({ error: 'Internal server error', reply: 'Sorry, something went wrong. Please try again.' });
        return;
      }
      res.status(result.status).json(result.body);
    } catch (err) {
      counters.errors++;
      logEvent('error', 'chat_error', { session_id: req.body && req.body.session_id, error: (err as Error).message });
      console.error('Chat error:', err);
      // A stage may already have sent part of a response. Writing to it now
      // throws ERR_HTTP_HEADERS_SENT and hides the real failure.
      if (res.headersSent) return;
      res.status(500).json({ error: 'Internal server error', reply: 'Sorry, something went wrong. Please try again.' });
    }
  });
}

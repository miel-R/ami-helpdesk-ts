// POST /api/ticket - validate, stage, hand to n8n.
//
// This is the whole of ticket creation. It reads the ticket, validates it twice,
// stages any upload, builds the payload and posts it to the flow; MIS does the
// rest. Nothing here is MIS-specific beyond the payload, which lives in
// webhook.service.ts because n8n and the form have to agree on it.

import type { Application, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { logEvent } from '../../core/logger';
import conversationManager from '../session.service';
import { requireSession } from './session-auth.service';
import type { ResolvedSession } from './session-auth.service';
import { validateFields, validateCatalogFields } from './validation.service';
import { stageAttachment, discardUploads } from './staging.service';
import { parseTicketTypeChoice } from '../../features/agent/ticket-intake';

// Multer's own type, so a wrong storage configuration is a compile error here
// rather than a runtime surprise on the first upload.
type FileUpload = ReturnType<typeof import('multer')>;

export function registerTicketRoutes(app: Application, upload: FileUpload): void {
  const auth = requireSession();
  const receiveAttachments = upload.array('attachments');

  app.post('/api/ticket', auth, receiveAttachments, async (req: Request, res: Response) => {
    try {
      const session = (req as Request & { amiSession?: ResolvedSession }).amiSession;
      if (!session) {
        res.status(401).json({ ok: false, errors: ['Not authenticated'] });
        return;
      }

      const ticketType = parseTicketTypeChoice(req.body.ticket_type as string);
      if (!ticketType) {
        res.status(400).json({ ok: false, errors: ['Invalid ticket_type'] });
        return;
      }

      let fields: Record<string, unknown> = {};
      try {
        fields = JSON.parse((req.body.fields as string) || '{}');
      } catch {
        res.status(400).json({ ok: false, errors: ['Invalid fields JSON'] });
        return;
      }

      // Validate required fields
      const fieldErrors = validateFields(ticketType, fields);
      if (fieldErrors.length) {
        res.status(400).json({ ok: false, errors: fieldErrors });
        return;
      }

      // Validate against MIS catalogs
      const catalogErrors = await validateCatalogFields(ticketType, fields);
      if (catalogErrors.length) {
        res.status(400).json({ ok: false, errors: catalogErrors });
        return;
      }

      // Process attachments
      const attachments: Array<Record<string, unknown>> = [];

      // IT Asset has no upload in the legacy form at all, so there is no folder
      // convention for n8n to file these under. Reject rather than accept them
      // and leave MIS with rows pointing at nothing.
      if (ticketType === 'it_asset' && Array.isArray(req.files) && req.files.length) {
        discardUploads(req.files);
        res.status(400).json({
          ok: false,
          errors: ['IT Asset requests cannot carry attachments']
        });
        return;
      }

      if (Array.isArray(req.files)) {
        const ticketKey = uuidv4();
        for (const file of req.files) {
          const staged = stageAttachment(file, ticketKey);
          attachments.push({
            ...staged,
            file_type: file.mimetype,
            file_size: file.size
          });
        }
      }

      const userDepartment = session.user.department || 'MIS';
      // The shared builder, so a real submission carries the same category_id and
      // system_id the $test-webhook probe does. This route used to assemble its
      // own payload with names only, which is why MIS filled scrf_sys_name with
      // free text whenever a ticket came from the form instead of the probe.
      const { buildResolvedPayload, triggerWebhook } = await import('./webhook.service');
      const payload = await buildResolvedPayload({
        ticketType,
        department: userDepartment,
        userName: session.displayName,
        user: session.user,
        collectedFields: fields as Record<string, string | number | string[]>,
        attachments
      });
      const webhookResult = await triggerWebhook(payload);

      if (!webhookResult.ok) {
        logEvent('warn', 'ticket_api_failed', { user: session.loginId, error: webhookResult.error, ticketType });
        res.status(502).json({ ok: false, errors: [webhookResult.error || 'MIS submission failed'] });
        return;
      }

      const body = (webhookResult.body ?? {}) as {
        control_number?: unknown;
        ticket_id?: unknown;
        success?: unknown;
        error?: unknown;
      };
      const controlNumber = body.control_number ? String(body.control_number).trim() : '';
      const reportedFailure = body.success === false || body.success === 0 || body.success === 'false';
      const workflowError = body.error ? String(body.error) : '';

      // Only an EXPLICIT failure is a failure.
      //
      // This used to treat a missing control_number as a rejection, on the
      // reasoning that no number meant nothing was saved. That is wrong, and it
      // was hiding a real outage behind a confusing message: the live workflow
      // responds `{ success: true, message: 'Ticket created', ticket_type }` and
      // has no control_number field at all, so every submission was reported as
      // "n8n accepted the request but returned no control number" - telling the
      // user their ticket failed when n8n had in fact accepted it.
      //
      // Whether the row landed is a question for the database, not for the shape
      // of n8n's reply. The control number is a separate concern: it is minted by
      // MIS on approval (scrf_num is NULL until then, which is why tickets sit at
      // "For MIS Assessment" with a null number), so its absence right now says
      // nothing about whether the request was saved.
      if (reportedFailure) {
        const rejectionReason = `n8n reported the ticket could not be saved${workflowError ? `: ${workflowError}` : ''}`;
        logEvent('warn', 'ticket_api_rejected', { user: session.loginId, error: rejectionReason, ticketType });
        res.status(502).json({ ok: false, errors: [rejectionReason] });
        return;
      }

      // n8n said yes but gave us no number. Accept the ticket and say so, rather
      // than reporting a failure that makes the user submit again and create a
      // duplicate. Logged as a warning because it means the workflow needs the
      // fixed Respond node, but it is not a reason to reject.
      if (!controlNumber) {
        logEvent('warn', 'ticket_api_no_control_number', {
          user: session.loginId,
          session_id: session.sessionId,
          ticket_type: ticketType,
          note: 'n8n accepted the ticket without a control_number; check the Respond to Webhook node'
        });
      }

      logEvent('info', 'ticket_api_created', {
        user: session.loginId,
        session_id: session.sessionId,
        ticket_type: ticketType,
        control_number: controlNumber
      });

      // The confirmation has to be a real, persisted assistant turn - not a bubble
      // the widget draws when the POST returns.
      //
      // It used to be added only on the client, which meant it existed for exactly
      // as long as the page did: reload the widget and the handover reply was still
      // there ("Got it, Remiel! Handing you over to MIS now.") but the ticket
      // confirmation under it had vanished. Pushed onto session.messages so
      // saveConversation appends it to the messages table like any other turn, and
      // skipped when the last turn already says the same thing, so a retry or a
      // double-submit cannot stack duplicate confirmations.
      const conversation = await conversationManager.getConversation(session.sessionId);
      const alreadySaid = conversation.messages.some(
        m => m.role === 'assistant' && controlNumber && m.content.includes(controlNumber)
      );
      if (!alreadySaid) {
        conversation.messages.push({
          role: 'assistant',
          content: controlNumber
            ? `\u2705 Ticket submitted. Control number: ${controlNumber}\n\nThe MIS team has been notified and will assist you shortly.`
            : '\u2705 Ticket submitted.\n\nThe MIS team has been notified and will assist you shortly.',
          timestamp: new Date().toISOString()
        });
      }

      // The conversation keeps going after a ticket: the user usually has more
      // to ask. Recording the control number lets a reload repeat the
      // confirmation from history instead of dropping the user into a blank
      // thread, and `status` is deliberately left alone so the widget does not
      // draw a "Session ended" divider the moment the ticket goes through.
      //
      // Only overwritten when there IS one: clearing it would make a reload lose
      // a number it could previously show.
      if (controlNumber) {
        (session as unknown as { last_control_number?: string }).last_control_number = controlNumber;
        conversation.last_control_number = controlNumber;
      }
      (session as unknown as { pending_goodbye?: string | null }).pending_goodbye = null;
      (session as unknown as { nudge_sent?: boolean }).nudge_sent = false;
      // Clear form_active - ticket submitted, form is done.
      //
      // On the CONVERSATION, not on `session`. `session` here is the
      // ResolvedSession from requireSession: a plain object rebuilt fresh on every
      // request, so deleting a property from it touched nothing the idle sweep
      // ever reads. The flag lives on the conversation bag, so that is the object
      // that has to lose it - otherwise a conversation whose form had been open
      // kept its `form_active` and the sweep skipped it forever, and the session
      // could never expire again.
      if (conversation.form_active) delete conversation.form_active;
      // Awaited: the control number is the only thing a reload can use to repeat
      // the confirmation, so it has to be durable before we report success.
      await conversationManager.saveConversation(session.sessionId);

      res.json({
        ok: true,
        control_number: controlNumber,
        // True when MIS accepted the ticket but has not issued a number yet.
        // The widget needs this to confirm the submission without printing a
        // control number it does not have.
        control_number_pending: !controlNumber,
        ticket_type: ticketType,
        // Tells the widget to offer the follow-up rather than close the thread.
        follow_up: true
      });
    } catch (err) {
      logEvent('error', 'ticket_api_error', { error: (err as Error).message });
      res.status(500).json({ ok: false, errors: ['Internal server error'] });
    }
  });

}
// GET /api/catalog/* - the option lists the ticket form offers.
//
// One route per dropdown, all of them read-only MIS queries behind the same
// session check as ticket creation: they expose the MIS directory, so they are
// not public.
//
// Each falls back to bare names if MIS is unreachable, so the dropdown still
// fills and the user can still choose. An empty dropdown is worse than one with
// labels, because there is nothing to pick from.

import type { Application, Request, Response } from 'express';
import * as catalog from './index';
import { requireSession } from '../ticket/session-auth.service';
import conversationManager from '../session.service';

// Extend Request to include amiSession
interface AuthenticatedRequest extends Request {
  amiSession: { sessionId: string };
}

export function registerCatalogRoutes(app: Application): void {
  const auth = requireSession();

  // Mark form as active whenever any catalog endpoint is hit, so the idle sweep
  // knows the user is filling a form and won't expire the session.
  // Tells the idle sweep the ticket form is open, so it does not expire the
  // session while someone is demonstrably present but not typing.
  //
  // The try/catch and the `next()` in both branches are the point. This runs
  // `getConversation` -> `restore()` -> `store.db()`, and `db()` throws
  // SYNCHRONOUSLY if `init()` has not finished. In an async middleware that
  // becomes a rejected promise, and Express 4 does not catch rejections from
  // middleware - so the request neither got a response nor called next(): the
  // form's dropdowns hung forever and an unhandled rejection surfaced. Presence
  // tracking is not worth a hung form, so a failure here is logged and skipped.
  const markFormActiveMiddleware = (req: Request, _res: Response, next: () => void) => {
    try {
      conversationManager.markFormActive((req as AuthenticatedRequest).amiSession.sessionId);
    } catch (e) {
      console.warn(`[catalog] could not mark form active: ${(e as Error).message}`);
    }
    next();
  };

  const authWithFormActivity = [auth, markFormActiveMiddleware];

  app.get('/api/catalog/departments', authWithFormActivity, async (_req: Request, res: Response) => {
    try { res.json(await catalog.departments()); } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });

  app.get('/api/catalog/locations', authWithFormActivity, async (_req: Request, res: Response) => {
    try { res.json(await catalog.locations()); } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });

  // Tech Support category: posts the request_category code (1-4) that
  // support_master.category stores, labelled with system_type exactly as the
  // legacy form renders it.
  app.get('/api/catalog/support-categories', authWithFormActivity, async (_req: Request, res: Response) => {
    try {
      const opts = await catalog.supportCategoryOptions();
      res.json(opts.length ? opts : (await catalog.supportCategoryTypes()).map(n => ({ id: '', name: n, group: '' })));
    } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });

  // System Request category: posts scrf_request_category.category_id.
  app.get('/api/catalog/request-categories', authWithFormActivity, async (_req: Request, res: Response) => {
    try {
      const opts = await catalog.systemRequestCategoryOptions();
      res.json(opts.length ? opts : (await catalog.systemRequestCategories()).map(n => ({ id: '', name: n, group: '' })));
    } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });

  // System Request system: posts scrf_request_category.category_id, comma-joined
  // into scrf_master.scrf_sys_name.
  app.get('/api/catalog/systems', authWithFormActivity, async (_req: Request, res: Response) => {
    try {
      const opts = await catalog.systemRequestSystemOptions();
      res.json(opts.length ? opts : (await catalog.systemRequestSystems()).map(n => ({ id: '', name: n, group: '' })));
    } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });

  // Tech Support system: a different table entirely (support_category.ID). Kept
  // separate rather than folded into /systems because mixing them is what had
  // Tech Support offering Oracle ERP and MES as things that break.
  app.get('/api/catalog/support-systems', authWithFormActivity, async (_req: Request, res: Response) => {
    try {
      const opts = await catalog.supportSystemOptions();
      res.json(opts.length ? opts : (await catalog.supportCategories()).map(n => ({ id: '', name: n, group: '' })));
    } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });

  // IT asset items: the on-hand count is shown beside the name ("AVR - 15") but
  // the name alone is what gets submitted, matching the legacy option value.
  app.get('/api/catalog/asset-items', authWithFormActivity, async (_req: Request, res: Response) => {
    try {
      const items = await catalog.itAssetItems();
      res.json(items);
    } catch { res.status(502).json({ error: 'MIS unavailable' }); }
  });
}

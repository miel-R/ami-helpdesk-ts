// Bits every admin route needs: the guard, an async wrapper, and query parsing.
//
// Kept separate so each controller below can be read on its own. They all arrived
// in one file with every route, which meant a change to any route meant reading all of them.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.ADMIN_KEY;
  if (!key) return next();
  const supplied = req.query.key || req.headers['x-admin-key'];
  if (supplied === key) return next();
  res.status(401).json({ error: 'Unauthorized. Pass ?key= or X-Admin-Key header.' });
}

/** Wrap an async handler so rejections become 500s instead of hanging. */
export function wrap(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err: Error) => {
      console.error(`[admin] ${req.method} ${req.path} failed:`, err);
      res.status(500).json({ error: err.message });
    });
  };
}

/** Read a bounded positive integer from the query string. */
export function intQuery(value: unknown, dflt: number, min: number, max: number): number {
  const n = parseInt(String(value ?? ''), 10) || dflt;
  return Math.min(Math.max(n, min), max);
}

/** Per-session token totals tracked on the in-memory conversation. */
export interface SessionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
}

/**
 * Register admin routes.
 */
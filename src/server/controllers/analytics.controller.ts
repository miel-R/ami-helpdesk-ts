// Analytics endpoints: the live data layer behind the dashboard.
//
//   GET /api/analytics/overview?days=30&username=
//   GET /api/analytics/timeseries?days=30&username=
//   GET /api/analytics/breakdown?days=30&username=&top=50
//   GET /api/analytics/realtime
//   GET /api/analytics/users?days=30
//   GET /api/analytics/sessions?limit=100
//   GET /api/admin/users/search?q=term&limit=10
//
// All GET, all guarded by requireAdmin. Aggregation lives in
// services/analytics-*.service.ts — this file only parses + responds.
import type { Application, Request, Response } from 'express';
import { requireAdmin, wrap, intQuery } from './admin.shared';
import { buildOverview, buildTimeseries } from '../services/analytics-overview.service';
import { buildBreakdown } from '../services/analytics-breakdown.service';
import { buildRealtime } from '../services/analytics-realtime.service';
import {
  getCostRatesWithSource, isValidRates, resetCostRates, saveCostRates
} from '../config/cost-rates.service';
import type { CostRates } from '../config/cost-rates.service';
import { num } from '../services/analytics-helpers';
import { buildSessions, buildUsers, searchUsers } from '../services/analytics-tables.service';

export function registerAnalyticsRoutes(app: Application): void {
  app.get('/api/analytics/overview', requireAdmin, wrap(async (req: Request, res: Response) => {
    const days = intQuery(req.query.days, 30, 1, 365);
    const username = req.query.username ? String(req.query.username) : null;
    res.json(await buildOverview(days, username));
  }));

  app.get('/api/analytics/timeseries', requireAdmin, wrap(async (req: Request, res: Response) => {
    const days = intQuery(req.query.days, 30, 1, 365);
    const username = req.query.username ? String(req.query.username) : null;
    res.json(await buildTimeseries(days, username));
  }));

  app.get('/api/analytics/breakdown', requireAdmin, wrap(async (req: Request, res: Response) => {
    const days = intQuery(req.query.days, 30, 1, 365);
    const username = req.query.username ? String(req.query.username) : null;
    const top = intQuery(req.query.top, 50, 1, 200);
    res.json(await buildBreakdown(days, username, top));
  }));

  app.get('/api/analytics/realtime', requireAdmin, wrap(async (_req: Request, res: Response) => {
    res.json(await buildRealtime());
  }));

  app.get('/api/analytics/users', requireAdmin, wrap(async (req: Request, res: Response) => {
    const days = intQuery(req.query.days, 30, 1, 365);
    res.json(await buildUsers(days));
  }));

  app.get('/api/analytics/sessions', requireAdmin, wrap(async (req: Request, res: Response) => {
    const limitParam = req.query.limit;
    let limit: number | 'all';
    if (limitParam === 'all') {
      limit = 'all';
    } else {
      limit = intQuery(limitParam, 100, 1, 10000);
    }
    const username = req.query.username ? String(req.query.username) : null;
    res.json(await buildSessions(limit, username));
  }));

  app.get('/api/admin/users/search', requireAdmin, wrap(async (req: Request, res: Response) => {
    const q = req.query.q ? String(req.query.q).trim() : '';
    const limit = intQuery(req.query.limit, 10, 1, 100);
    if (!q) {
      res.json({ timestamp: new Date().toISOString(), users: [] });
      return;
    }
    const users = await searchUsers(q, limit);
    res.json({ timestamp: new Date().toISOString(), users });
  }));

  // GET /api/admin/cost-rates
  // The rates the Per Session Cost table prices tokens at.
  app.get('/api/admin/cost-rates', requireAdmin, wrap(async (_req: Request, res: Response) => {
    res.json({
      timestamp: new Date().toISOString(),
      rates: getCostRatesWithSource()
    });
  }));

  // POST /api/admin/cost-rates
  // Edited from the Live tab's rate panel. Only the two rate fields are read:
  // an unexpected key is ignored rather than stored, so a typo'd field name
  // cannot silently create a third rate that nothing ever applies.
  app.post('/api/admin/cost-rates', requireAdmin, wrap(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Validated on the RAW value, then coerced.
    //
    // Coercing first turned "abc" into 0 and accepted it, so a typo silently
    // saved a $0 rate and zeroed the cost column instead of being refused.
    if (!isValidRates(body)) {
      res.status(400).json({
        error: 'Rates must be numbers between 0 and 100000.',
        rates: getCostRatesWithSource()
      });
      return;
    }
    const patch: Partial<CostRates> = {};
    if (body.input_per_million !== undefined) patch.input_per_million = num(body.input_per_million);
    if (body.output_per_million !== undefined) patch.output_per_million = num(body.output_per_million);

    if (!isValidRates(patch)) {
      // 400 rather than a silent no-op: a rejected rate that returned 200 would
      // look saved in the UI and take effect only after the next restart.
      res.status(400).json({
        error: 'Rates must be numbers between 0 and 100000.',
        rates: getCostRatesWithSource()
      });
      return;
    }
    const saved = await saveCostRates(patch);
    res.json({
      timestamp: new Date().toISOString(),
      rates: { ...saved, source: 'custom' as const }
    });
  }));

  // DELETE /api/admin/cost-rates
  // Drops the override and goes back to the shipped defaults.
  app.delete('/api/admin/cost-rates', requireAdmin, wrap(async (_req: Request, res: Response) => {
    const rates = await resetCostRates();
    res.json({
      timestamp: new Date().toISOString(),
      rates: { ...rates, source: 'default' as const }
    });
  }));
}

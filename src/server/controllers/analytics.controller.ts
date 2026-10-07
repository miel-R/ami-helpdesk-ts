// Analytics endpoints: the live data layer behind the dashboard.
//
//   GET /api/analytics/overview?days=30&username=
//   GET /api/analytics/timeseries?days=30&username=
//   GET /api/analytics/breakdown?days=30&username=&top=50
//   GET /api/analytics/realtime
//   GET /api/analytics/users?days=30
//   GET /api/analytics/sessions?limit=100
//
// All GET, all guarded by requireAdmin. Aggregation lives in
// services/analytics-*.service.ts — this file only parses + responds.
import type { Application, Request, Response } from 'express';
import { requireAdmin, wrap, intQuery } from './admin.shared';
import { buildOverview, buildTimeseries } from '../services/analytics-overview.service';
import { buildBreakdown } from '../services/analytics-breakdown.service';
import { buildRealtime } from '../services/analytics-realtime.service';
import { buildSessions, buildUsers } from '../services/analytics-tables.service';

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
    const limit = intQuery(req.query.limit, 100, 1, 500);
    res.json(await buildSessions(limit));
  }));
}

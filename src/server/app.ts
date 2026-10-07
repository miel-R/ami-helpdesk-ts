// Express wiring. This file configures the app and registers routes. It contains
// no business logic and no feature code.
//
// That constraint is the point. The server used to be one 857-line main.ts that
// built the app, ran the retention sweep, handled SIGTERM and held the entire
// chat handler, so any change meant reading all of it and any mistake took
// unrelated features with it. Splitting along this line means a feature lives in
// a controller, and this file only has to say which routes exist.
//
// Bootstrap - database, schedulers, listen, signals - lives in index.ts.

import express from 'express';
import type { Application, NextFunction, Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import compression from 'compression';

import { config } from './config/config.service';
import { logEvent, counters } from './core/logger';
import { registerDashboardRoutes } from './controllers/dashboard.controller';
import { registerAnalyticsRoutes } from './controllers/analytics.controller';
import { registerCatalogRoutes } from './services/catalog';
import { registerHistoryRoutes } from './controllers/history.controller';
import { registerUsageRoutes } from './controllers/usage.controller';
import { registerUserAdminRoutes } from './controllers/users.controller';
import { registerTicketRoutes } from './services/ticket/ticket.controller';
import { stagingDestination } from './services/ticket/staging.service';
import { registerChatRoutes } from './controllers/chat.controller';
import { registerHealthRoutes } from './controllers/health.controller';
import { registerFileRoutes } from './controllers/files.controller';

const app: Application = express();

// Tell Express how many proxies sit in front of it, so `req.ip` is the CLIENT's
// address and not the proxy's. Apache is expected in production.
//
// This has to be set before anything reads req.ip, which is the rate limiter
// below. Without it every request appeared to come from one host, so the limiter
// keyed on that single address and the whole company shared one bucket - 30
// messages a minute between everyone, and a 429 for people who had sent nothing.
//
// A number, not `true`: `true` trusts every hop in the chain and lets a client
// set `X-Forwarded-For` itself, which would let anyone bypass the limit. The
// count is verified against the real socket chain. See config.security.
app.set('trust proxy', config.security.trustProxyHops);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Widget assets are deliberately NOT cached.
//
// The list has to cover the whole module graph, not just the entry points.
// widget.js imports widget/main.js, which imports modal.js, api.js and the rest,
// and those are bare specifiers with no version in them. Listing only the entry
// points left modal.js on express.static's default, so a browser could pair a
// freshly fetched main.js with a cached modal.js - and that is exactly how the
// grouped system picker kept rendering the pre-fix code after it was deployed.
app.use(
  (req: Request, res: Response, next: NextFunction) => {
    const p = req.path || '';
    const isWidgetAsset =
      p === '/widget.js' ||
      p === '/ami-session.js' ||
      p === '/widget.css' ||
      // Covers /widget/*.js: main, modal, api, config, events, icons, state, ui.
      /^\/widget\/[\w-]+\.(js|css)$/.test(p) ||
      // Same assets again under the MIS-mounted path.
      /^\/mis_helpdesk\/ami-helpdesk\/(widget\.js|widget\.css|ami-session\.js|widget\/[\w-]+\.(js|css))$/.test(p);
    if (!isWidgetAsset) { next(); return; }
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
  }
);
app.use(express.static(config.paths.publicDir));
app.use('/mis_helpdesk/ami-helpdesk', express.static(config.paths.publicDir));

const tempDir = process.env.NODE_ENV === 'production' ? '/tmp' : 'uploads';
const HARD_UPLOAD_CEILING = Math.max(config.security.maxFileSize * 10, 100 * 1024 * 1024);

/**
 * Identify the caller for rate limiting, preferring a real person over an address.
 *
 * `login_user` is signed by the MIS PHP page with IDENTITY_SECRET, so it is the
 * only key here that cannot be forged by picking a different `X-Session-ID`. The
 * IP is the fallback for requests that never got that far - and with `trust proxy`
 * set it is now the client's address rather than the proxy's.
 *
 * Two people behind one NAT (a shared office, a site with a single egress IP)
 * would otherwise still share a bucket, so the login has to win when present.
 */
function rateLimitKey(req: Request): string {
  const login = String((req.body as Record<string, unknown> | undefined)?.login_user ?? '').trim();
  if (login) return `login:${login}`;
  return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

const chatLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.perMinute,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/chat', chatLimiter);

/**
 * A generous ceiling for the read-only widget endpoints.
 *
 * `/api/history/:id` is unauthenticated (the widget boots from it and carries no
 * credential), and it CREATES an in-memory conversation for whatever id it is
 * given, firing two Postgres queries per request. Looping it over random ids grew
 * the conversation map permanently and doubled the query load, so it needs a
 * limit - but a high one, because one page load legitimately makes several
 * history calls (initial load plus older pages as the user scrolls back).
 *
 * Keyed the same way as the chat limiter, so one person's paging cannot exhaust
 * everyone else's allowance.
 */
const widgetReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: rateLimitKey,
  message: { error: 'Too many requests, please slow down.' }
});
app.use('/api/history', widgetReadLimiter);
app.use('/api/session', widgetReadLimiter);

// One access log for every request, rather than one per handler.
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  counters.totalRequests++;
  res.on('finish', () => {
    const ms = Date.now() - start;
    logEvent('info', 'http', { method: req.method, path: req.path, status: res.statusCode, ms });
  });
  next();
});

registerDashboardRoutes(app);
registerAnalyticsRoutes(app);
registerHistoryRoutes(app);
registerUsageRoutes(app);
registerUserAdminRoutes(app);
// Ticket uploads go straight into the staging tree rather than a temp dir, so the
// staged path handed to n8n is a real path and not a second hop. The directory
// is resolved per request through diskStorage: multer's `dest` only accepts a
// literal string, and creating it at startup would mean the server refuses to
// boot whenever the NAS share is unmounted.
registerTicketRoutes(app, multer({
  storage: multer.diskStorage({ destination: stagingDestination }),
  limits: { fileSize: HARD_UPLOAD_CEILING }
}));
registerChatRoutes(app, multer({ dest: tempDir, limits: { fileSize: HARD_UPLOAD_CEILING } }));
registerCatalogRoutes(app);
registerHealthRoutes(app);
registerFileRoutes(app);

export { app };

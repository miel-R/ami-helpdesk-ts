// Serving files the widget uploaded, and the catch-all for unknown /api routes.

import type { Application, Request, Response } from 'express';
import { serveFile } from '../services/file.service';

export function registerFileRoutes(app: Application): void {app.get('/api/files/:name', (req: Request, res: Response) => {
  if (!serveFile(String(req.params.name || ''), res)) {
    res.status(404).json({ error: 'File not found' });
  }
});
}

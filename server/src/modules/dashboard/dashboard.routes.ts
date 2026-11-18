import { Router } from 'express';
import type { Config } from '../../config.js';
import type { Db } from '../../db.js';
import { asyncHandler } from '../../http.js';
import { authenticate, currentUser } from '../../middleware/authenticate.js';
import { DashboardService } from './dashboard.service.js';

export function dashboardRouter(db: Db, config: Config): Router {
  const router = Router();
  const service = new DashboardService(db, config.DASHBOARD_CACHE_TTL_SECONDS * 1000);
  router.use(authenticate(config));

  router.get('/', asyncHandler(async (req, res) => {
    // Per-user data: must never be stored by a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(await service.get(currentUser(req)));
  }));

  return router;
}

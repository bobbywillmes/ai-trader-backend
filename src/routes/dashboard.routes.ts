import { Router } from 'express';
import {
  getIndexIntradayController,
  getIndexPerformanceController,
  getDashboardAccountsOverviewController,
} from '../controllers/dashboard.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/accounts-overview', requirePermission(PlatformPermission.REPORTS_READ), getDashboardAccountsOverviewController);
router.get('/index-performance', requirePermission(PlatformPermission.REPORTS_READ), getIndexPerformanceController);
router.get('/index-intraday', requirePermission(PlatformPermission.REPORTS_READ), getIndexIntradayController);

export default router;

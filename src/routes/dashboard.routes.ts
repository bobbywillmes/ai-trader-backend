import { Router } from 'express';
import {
  getIndexPerformanceController,
  getDashboardAccountsOverviewController,
  getDashboardReferencePricesController,
  getDashboardMarketStateController,
} from '../controllers/dashboard.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/accounts-overview', requirePermission(PlatformPermission.REPORTS_READ), getDashboardAccountsOverviewController);
router.get('/index-performance', requirePermission(PlatformPermission.REPORTS_READ), getIndexPerformanceController);
router.get('/reference-prices', requirePermission(PlatformPermission.REPORTS_READ), getDashboardReferencePricesController);
router.get('/market-state', requirePermission(PlatformPermission.REPORTS_READ), getDashboardMarketStateController);

export default router;

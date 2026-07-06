import { Router } from 'express';
import {
  getIndexIntradayController,
  getIndexPerformanceController,
} from '../controllers/dashboard.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/index-performance', requirePermission(AdminPermission.REPORTS_READ), getIndexPerformanceController);
router.get('/index-intraday', requirePermission(AdminPermission.REPORTS_READ), getIndexIntradayController);

export default router;

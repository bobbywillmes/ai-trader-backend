import { Router } from 'express';
import { tradePerformanceController } from '../controllers/trade-performance.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.REPORTS_READ), tradePerformanceController);

export default router;

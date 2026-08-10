import { Router } from 'express';
import { tradePerformanceController } from '../controllers/trade-performance.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.REPORTS_READ), tradePerformanceController);

export default router;

import { Router } from 'express';
import { tradePerformanceController } from '../controllers/trade-performance.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, tradePerformanceController);

export default router;

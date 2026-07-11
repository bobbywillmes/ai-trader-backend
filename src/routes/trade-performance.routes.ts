import { Router } from 'express';
import { tradePerformanceController } from '../controllers/trade-performance.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, tradePerformanceController);

export default router;

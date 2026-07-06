import { Router } from 'express';
import {
  getCurrentMarketStateController,
  updateCurrentMarketStateController,
} from '../controllers/market-state.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/current', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getCurrentMarketStateController);
router.patch('/current', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), updateCurrentMarketStateController);

export default router;
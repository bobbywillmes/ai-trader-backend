import { Router } from 'express';
import {
  closePositionController,
  positionsController
} from '../controllers/positions.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), positionsController);
router.delete('/:symbol', requirePermission(AdminPermission.TRADING_ACCOUNT_RISK_WRITE), closePositionController);

export default router;
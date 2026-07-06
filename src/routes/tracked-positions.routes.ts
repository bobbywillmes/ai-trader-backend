import { Router } from 'express';
import {
  openTrackedPositionsController,
  trackedPositionsController
} from '../controllers/tracked-positions.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/open', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), openTrackedPositionsController);
router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), trackedPositionsController);

export default router;
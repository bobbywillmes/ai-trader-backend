import { Router } from 'express';
import {
  getAllSecuritiesController,
  getSecuritiesSummaryController,
  findSecurityController,
  addSecurityController,
  updateSecurityController,
} from '../controllers/securities.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/summary', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getSecuritiesSummaryController);
router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getAllSecuritiesController);
router.get('/:symbol', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), findSecurityController);
router.post('/', requirePermission(AdminPermission.STRATEGY_WRITE), addSecurityController);
router.patch('/:symbol', requirePermission(AdminPermission.STRATEGY_WRITE), updateSecurityController);

export default router;
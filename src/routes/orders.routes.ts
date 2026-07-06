import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController,
  cancelAllOrdersController
} from '../controllers/orders.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/open', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), openOrdersController);
router.post('/', requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), placeOrderController);
router.delete('/', requirePermission(AdminPermission.TRADING_ACCOUNT_RISK_WRITE), cancelAllOrdersController);
router.delete('/:orderId', requirePermission(AdminPermission.TRADING_ACCOUNT_RISK_WRITE), cancelOrderController);

export default router;
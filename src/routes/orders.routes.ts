import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController,
  cancelAllOrdersController,
  scopedOpenOrdersController,
} from '../controllers/orders.controller.js';
import {
  requirePermission,
  requireSystemOwnerAccess,
  requireTradingAccountAccess,
} from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

// Default account read requires owner access (no account-scoping)
router.get('/open', requireSystemOwnerAccess, openOrdersController);
router.get('/open/scoped', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), scopedOpenOrdersController);
// Default account operations require owner access (no account-scoping yet)
router.post('/', requireSystemOwnerAccess, placeOrderController);
router.delete(
  '/trading-accounts/:tradingAccountId',
  requireSystemOwnerAccess,
  requireTradingAccountAccess('tradingAccountId'),
  cancelAllOrdersController
);
router.delete(
  '/trading-accounts/:tradingAccountId/:orderId',
  requireSystemOwnerAccess,
  requireTradingAccountAccess('tradingAccountId'),
  cancelOrderController
);

export default router;

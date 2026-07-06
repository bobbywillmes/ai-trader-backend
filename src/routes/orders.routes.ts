import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController,
  cancelAllOrdersController
} from '../controllers/orders.controller.js';
import { requirePermission, requireOwnerAccess } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/open', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), openOrdersController);
// Default account operations require owner access (no account-scoping yet)
router.post('/', requireOwnerAccess, placeOrderController);
router.delete('/', requireOwnerAccess, cancelAllOrdersController);
router.delete('/:orderId', requireOwnerAccess, cancelOrderController);

export default router;
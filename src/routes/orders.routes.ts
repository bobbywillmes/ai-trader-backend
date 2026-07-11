import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController,
  cancelAllOrdersController
} from '../controllers/orders.controller.js';
import { requirePermission, requireOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

// Default account read requires owner access (no account-scoping)
router.get('/open', requireOwnerAccess, openOrdersController);
// Default account operations require owner access (no account-scoping yet)
router.post('/', requireOwnerAccess, placeOrderController);
router.delete('/', requireOwnerAccess, cancelAllOrdersController);
router.delete('/:orderId', requireOwnerAccess, cancelOrderController);

export default router;
import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController,
  cancelAllOrdersController
} from '../controllers/orders.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

// Default account read requires owner access (no account-scoping)
router.get('/open', requireSystemOwnerAccess, openOrdersController);
// Default account operations require owner access (no account-scoping yet)
router.post('/', requireSystemOwnerAccess, placeOrderController);
router.delete('/', requireSystemOwnerAccess, cancelAllOrdersController);
router.delete('/:orderId', requireSystemOwnerAccess, cancelOrderController);

export default router;
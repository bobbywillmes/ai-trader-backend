import { Router } from 'express';
import {
  createSubscriptionController,
  subscriptionByKeyController,
  subscriptionsController,
  updateSubscriptionController
} from '../controllers/subscription.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.SUBSCRIPTION_READ), subscriptionsController);
router.post('/', requirePermission(AdminPermission.SUBSCRIPTION_WRITE), createSubscriptionController);
router.get('/:key', requirePermission(AdminPermission.SUBSCRIPTION_READ), subscriptionByKeyController);
router.patch('/:id', requirePermission(AdminPermission.SUBSCRIPTION_WRITE), updateSubscriptionController);

export default router;
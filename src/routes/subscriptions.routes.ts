import { Router } from 'express';
import {
  createSubscriptionController,
  subscriptionByKeyController,
  subscriptionsController,
  updateSubscriptionController
} from '../controllers/subscription.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, subscriptionsController);
router.post('/', requireOwnerAccess, createSubscriptionController);
router.get('/:key', requireOwnerAccess, subscriptionByKeyController);
router.patch('/:id', requireOwnerAccess, updateSubscriptionController);

export default router;

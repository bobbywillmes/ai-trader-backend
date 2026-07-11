import { Router } from 'express';
import {
  createSubscriptionController,
  subscriptionByKeyController,
  subscriptionsController,
  updateSubscriptionController
} from '../controllers/subscription.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, subscriptionsController);
router.post('/', requireSystemOwnerAccess, createSubscriptionController);
router.get('/:key', requireSystemOwnerAccess, subscriptionByKeyController);
router.patch('/:id', requireSystemOwnerAccess, updateSubscriptionController);

export default router;

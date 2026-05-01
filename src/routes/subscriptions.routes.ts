import { Router } from 'express';
import {
  createSubscriptionController,
  subscriptionByKeyController,
  subscriptionsController,
  updateSubscriptionController
} from '../controllers/subscription.controller.js';

const router = Router();

router.get('/', subscriptionsController);
router.post('/', createSubscriptionController);
router.get('/:key', subscriptionByKeyController);
router.patch('/:id', updateSubscriptionController);

export default router;
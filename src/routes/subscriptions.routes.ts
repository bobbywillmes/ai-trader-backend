import { Router } from 'express';
import {
  subscriptionByKeyController,
  subscriptionsController
} from '../controllers/subscription.controller.js';

const router = Router();

router.get('/', subscriptionsController);
router.get('/:key', subscriptionByKeyController);

export default router;
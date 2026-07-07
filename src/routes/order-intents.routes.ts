import { Router } from 'express';
import {
  orderIntentByIdController,
  orderIntentsController
} from '../controllers/order-intents.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, orderIntentsController);
router.get('/:id', requireOwnerAccess, orderIntentByIdController);

export default router;

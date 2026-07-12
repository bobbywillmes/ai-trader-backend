import { Router } from 'express';
import {
  orderIntentByIdController,
  orderIntentsController
} from '../controllers/order-intents.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, orderIntentsController);
router.get('/:id', requireSystemOwnerAccess, orderIntentByIdController);

export default router;

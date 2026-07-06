import { Router } from 'express';
import {
  orderIntentByIdController,
  orderIntentsController
} from '../controllers/order-intents.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), orderIntentsController);
router.get('/:id', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), orderIntentByIdController);

export default router;
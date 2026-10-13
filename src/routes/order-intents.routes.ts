import { Router } from 'express';
import {
  orderIntentByIdController,
  orderIntentHistoryController,
  orderIntentOperationalEvidenceController,
  orderIntentsController
} from '../controllers/order-intents.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, orderIntentsController);
router.get('/history', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), orderIntentHistoryController);
router.get('/:orderIntentId/operational-evidence', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), orderIntentOperationalEvidenceController);
router.get('/:id', requireSystemOwnerAccess, orderIntentByIdController);

export default router;

import { Router } from 'express';
import {
  entryDecisionByIdController,
  entryDecisionsController,
} from '../controllers/entry-decisions.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), entryDecisionsController);
router.get('/:id', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), entryDecisionByIdController);

export default router;

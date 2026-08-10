import { Router } from 'express';
import {
  entryDecisionByIdController,
  entryDecisionsController,
} from '../controllers/entry-decisions.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), entryDecisionsController);
router.get('/:id', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), entryDecisionByIdController);

export default router;

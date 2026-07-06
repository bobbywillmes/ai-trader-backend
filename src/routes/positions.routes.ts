import { Router } from 'express';
import {
  closePositionController,
  positionsController
} from '../controllers/positions.controller.js';
import { requirePermission, requireOwnerAccess } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), positionsController);
// Close position on default account requires owner access (no account-scoping yet)
router.delete('/:symbol', requireOwnerAccess, closePositionController);

export default router;
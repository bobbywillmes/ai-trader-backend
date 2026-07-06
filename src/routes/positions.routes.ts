import { Router } from 'express';
import {
  closePositionController,
  positionsController
} from '../controllers/positions.controller.js';
import { requirePermission, requireOwnerAccess } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

// Default account read requires owner access (no account-scoping)
router.get('/', requireOwnerAccess, positionsController);
// Close position on default account requires owner access (no account-scoping yet)
router.delete('/:symbol', requireOwnerAccess, closePositionController);

export default router;
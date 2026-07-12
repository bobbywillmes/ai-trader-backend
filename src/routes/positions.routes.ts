import { Router } from 'express';
import {
  closePositionController,
  positionsController
} from '../controllers/positions.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

// Default account read requires owner access (no account-scoping)
router.get('/', requireSystemOwnerAccess, positionsController);
// Close position on default account requires owner access (no account-scoping yet)
router.delete('/:symbol', requireSystemOwnerAccess, closePositionController);

export default router;
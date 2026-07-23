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
// The tracked-position identity resolves exactly one account and assignment.
router.delete(
  '/:trackedPositionId',
  requireSystemOwnerAccess,
  closePositionController
);

export default router;

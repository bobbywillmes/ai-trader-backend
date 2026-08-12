import { Router } from 'express';
import {
  createManualAccountSnapshotController,
  getAccountSnapshotTrendsController,
  getAccountSnapshotsController,
  getLatestAccountSnapshotController,
} from '../controllers/account-snapshots.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/trends', requirePermission(PlatformPermission.REPORTS_READ), getAccountSnapshotTrendsController);
router.get('/latest', requireSystemOwnerAccess, getLatestAccountSnapshotController);
router.get('/', requirePermission(PlatformPermission.REPORTS_READ), getAccountSnapshotsController);
// Manual snapshots require owner access (mutating operation)
router.post('/manual', requireSystemOwnerAccess, createManualAccountSnapshotController);

export default router;

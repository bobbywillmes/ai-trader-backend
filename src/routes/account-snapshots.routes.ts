import { Router } from 'express';
import {
  createManualAccountSnapshotController,
  getAccountSnapshotTrendsController,
  getAccountSnapshotsController,
  getLatestAccountSnapshotController,
} from '../controllers/account-snapshots.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/trends', requireSystemOwnerAccess, getAccountSnapshotTrendsController);
router.get('/latest', requireSystemOwnerAccess, getLatestAccountSnapshotController);
router.get('/', requireSystemOwnerAccess, getAccountSnapshotsController);
// Manual snapshots require owner access (mutating operation)
router.post('/manual', requireSystemOwnerAccess, createManualAccountSnapshotController);

export default router;

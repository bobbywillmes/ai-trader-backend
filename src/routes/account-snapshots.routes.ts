import { Router } from 'express';
import {
  createManualAccountSnapshotController,
  getAccountSnapshotTrendsController,
  getAccountSnapshotsController,
  getLatestAccountSnapshotController,
} from '../controllers/account-snapshots.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/trends', requireOwnerAccess, getAccountSnapshotTrendsController);
router.get('/latest', requireOwnerAccess, getLatestAccountSnapshotController);
router.get('/', requireOwnerAccess, getAccountSnapshotsController);
// Manual snapshots require owner access (mutating operation)
router.post('/manual', requireOwnerAccess, createManualAccountSnapshotController);

export default router;

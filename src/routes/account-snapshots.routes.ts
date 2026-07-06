import { Router } from 'express';
import {
  createManualAccountSnapshotController,
  getAccountSnapshotTrendsController,
  getAccountSnapshotsController,
  getLatestAccountSnapshotController,
} from '../controllers/account-snapshots.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/trends', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getAccountSnapshotTrendsController);
router.get('/latest', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getLatestAccountSnapshotController);
router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getAccountSnapshotsController);
router.post('/manual', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), createManualAccountSnapshotController);

export default router;

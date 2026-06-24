import { Router } from 'express';
import {
  createManualAccountSnapshotController,
  getAccountSnapshotTrendsController,
  getAccountSnapshotsController,
  getLatestAccountSnapshotController,
} from '../controllers/account-snapshots.controller.js';

const router = Router();

router.get('/trends', getAccountSnapshotTrendsController);
router.get('/latest', getLatestAccountSnapshotController);
router.get('/', getAccountSnapshotsController);
router.post('/manual', createManualAccountSnapshotController);

export default router;

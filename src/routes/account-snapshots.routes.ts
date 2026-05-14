import { Router } from 'express';
import {
  createManualAccountSnapshotController,
  getAccountSnapshotsController,
  getLatestAccountSnapshotController,
} from '../controllers/account-snapshots.controller.js';

const router = Router();

router.get('/', getAccountSnapshotsController);
router.get('/latest', getLatestAccountSnapshotController);
router.post('/manual', createManualAccountSnapshotController);

export default router;
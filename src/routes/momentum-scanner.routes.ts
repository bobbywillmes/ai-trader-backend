import { Router } from 'express';

import {
  acknowledgeMomentumScannerHandoffController,
  getMomentumScannerHandoffController,
  listMomentumScannerHandoffsController,
  markMomentumScannerHandoffFailedController,
  markMomentumScannerHandoffSentController,
  prepareMomentumScannerHandoffsController,
} from '../controllers/momentum-scanner-handoffs.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/handoffs', requireOwnerAccess, listMomentumScannerHandoffsController);
router.post('/handoffs/prepare', requireOwnerAccess, prepareMomentumScannerHandoffsController);
router.post('/handoffs/:id/mark-sent', requireOwnerAccess, markMomentumScannerHandoffSentController);
router.post('/handoffs/:id/acknowledge', requireOwnerAccess, acknowledgeMomentumScannerHandoffController);
router.post('/handoffs/:id/mark-failed', requireOwnerAccess, markMomentumScannerHandoffFailedController);
router.get('/handoffs/:id', requireOwnerAccess, getMomentumScannerHandoffController);

export default router;

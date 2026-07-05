import { Router } from 'express';

import {
  acknowledgeMomentumScannerHandoffController,
  getMomentumScannerHandoffController,
  listMomentumScannerHandoffsController,
  markMomentumScannerHandoffFailedController,
  markMomentumScannerHandoffSentController,
  prepareMomentumScannerHandoffsController,
} from '../controllers/momentum-scanner-handoffs.controller.js';

const router = Router();

router.get('/handoffs', listMomentumScannerHandoffsController);
router.post('/handoffs/prepare', prepareMomentumScannerHandoffsController);
router.post('/handoffs/:id/mark-sent', markMomentumScannerHandoffSentController);
router.post('/handoffs/:id/acknowledge', acknowledgeMomentumScannerHandoffController);
router.post('/handoffs/:id/mark-failed', markMomentumScannerHandoffFailedController);
router.get('/handoffs/:id', getMomentumScannerHandoffController);

export default router;

import { Router } from 'express';

import {
  acknowledgeMomentumScannerHandoffController,
  getMomentumScannerHandoffController,
  listMomentumScannerHandoffsController,
  markMomentumScannerHandoffFailedController,
  markMomentumScannerHandoffSentController,
  prepareMomentumScannerHandoffsController,
} from '../controllers/momentum-scanner-handoffs.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/handoffs', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listMomentumScannerHandoffsController);
router.post('/handoffs/prepare', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), prepareMomentumScannerHandoffsController);
router.post('/handoffs/:id/mark-sent', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), markMomentumScannerHandoffSentController);
router.post('/handoffs/:id/acknowledge', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), acknowledgeMomentumScannerHandoffController);
router.post('/handoffs/:id/mark-failed', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), markMomentumScannerHandoffFailedController);
router.get('/handoffs/:id', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getMomentumScannerHandoffController);

export default router;

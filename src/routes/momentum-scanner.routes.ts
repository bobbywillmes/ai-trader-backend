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
import {
  getMomentumResearchOverviewController,
  listMomentumResearchCandidatesController,
  listMomentumResearchCatalystsController,
} from '../controllers/momentum-research.controller.js';
import {
  createMomentumUniverseController,
  deleteMomentumUniverseController,
  listMomentumUniverseController,
  updateMomentumUniverseController,
} from '../controllers/momentum-universe.controller.js';

const router = Router();

router.get('/research/overview', requireOwnerAccess, getMomentumResearchOverviewController);
router.get('/research/candidates', requireOwnerAccess, listMomentumResearchCandidatesController);
router.get('/research/catalysts', requireOwnerAccess, listMomentumResearchCatalystsController);

router.get('/universe', requireOwnerAccess, listMomentumUniverseController);
router.post('/universe', requireOwnerAccess, createMomentumUniverseController);
router.patch('/universe/:id', requireOwnerAccess, updateMomentumUniverseController);
router.delete('/universe/:id', requireOwnerAccess, deleteMomentumUniverseController);

router.get('/handoffs', requireOwnerAccess, listMomentumScannerHandoffsController);
router.post('/handoffs/prepare', requireOwnerAccess, prepareMomentumScannerHandoffsController);
router.post('/handoffs/:id/mark-sent', requireOwnerAccess, markMomentumScannerHandoffSentController);
router.post('/handoffs/:id/acknowledge', requireOwnerAccess, acknowledgeMomentumScannerHandoffController);
router.post('/handoffs/:id/mark-failed', requireOwnerAccess, markMomentumScannerHandoffFailedController);
router.get('/handoffs/:id', requireOwnerAccess, getMomentumScannerHandoffController);

export default router;

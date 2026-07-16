import { Router } from 'express';

import {
  acknowledgeMomentumScannerHandoffController,
  getMomentumScannerHandoffController,
  listMomentumScannerHandoffsController,
  markMomentumScannerHandoffFailedController,
  markMomentumScannerHandoffSentController,
  prepareMomentumScannerHandoffsController,
} from '../controllers/momentum-scanner-handoffs.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';
import {
  getMomentumResearchOverviewController,
  getMomentumResearchCandidateController,
  getMomentumSymbolResearchController,
  listMomentumResearchCandidatesController,
  listMomentumResearchCatalystsController,
} from '../controllers/momentum-research.controller.js';
import {
  createMomentumUniverseController,
  deleteMomentumUniverseController,
  listMomentumUniverseController,
  updateMomentumUniverseController,
} from '../controllers/momentum-universe.controller.js';
import { getMomentumMarketChartController } from '../controllers/momentum-market-chart.controller.js';
import {
  getMomentumPipelineRunController,
  latestMomentumPipelineRunsController,
  listMomentumPipelineRunsController,
} from '../controllers/momentum-pipeline-runs.controller.js';

const router = Router();

router.get('/research/overview', requireSystemOwnerAccess, getMomentumResearchOverviewController);
router.get('/research/pipeline-runs/latest', requireSystemOwnerAccess, latestMomentumPipelineRunsController);
router.get('/research/pipeline-runs', requireSystemOwnerAccess, listMomentumPipelineRunsController);
router.get('/research/pipeline-runs/:runId', requireSystemOwnerAccess, getMomentumPipelineRunController);
router.get('/research/candidates', requireSystemOwnerAccess, listMomentumResearchCandidatesController);
router.get('/research/candidates/:candidateId', requireSystemOwnerAccess, getMomentumResearchCandidateController);
router.get('/research/catalysts', requireSystemOwnerAccess, listMomentumResearchCatalystsController);
router.get('/research/symbols/:symbol', requireSystemOwnerAccess, getMomentumSymbolResearchController);
router.get('/research/symbols/:symbol/chart', requireSystemOwnerAccess, getMomentumMarketChartController);

router.get('/universe', requireSystemOwnerAccess, listMomentumUniverseController);
router.post('/universe', requireSystemOwnerAccess, createMomentumUniverseController);
router.patch('/universe/:id', requireSystemOwnerAccess, updateMomentumUniverseController);
router.delete('/universe/:id', requireSystemOwnerAccess, deleteMomentumUniverseController);

router.get('/handoffs', requireSystemOwnerAccess, listMomentumScannerHandoffsController);
router.post('/handoffs/prepare', requireSystemOwnerAccess, prepareMomentumScannerHandoffsController);
router.post('/handoffs/:id/mark-sent', requireSystemOwnerAccess, markMomentumScannerHandoffSentController);
router.post('/handoffs/:id/acknowledge', requireSystemOwnerAccess, acknowledgeMomentumScannerHandoffController);
router.post('/handoffs/:id/mark-failed', requireSystemOwnerAccess, markMomentumScannerHandoffFailedController);
router.get('/handoffs/:id', requireSystemOwnerAccess, getMomentumScannerHandoffController);

export default router;

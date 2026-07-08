import { Router } from 'express';
import {
  confirmMomentumCandidatePriceController,
  confirmMomentumCandidatePricesController,
  expireStaleMomentumCandidatesController,
  generateMomentumCandidatesController,
  getMomentumCandidateController,
  listMomentumCandidatePriceChecksController,
  listMomentumCandidatesController,
} from '../controllers/momentum-candidates.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, listMomentumCandidatesController);
router.post('/generate-from-catalysts', requireOwnerAccess, generateMomentumCandidatesController);
router.post('/expire-stale', requireOwnerAccess, expireStaleMomentumCandidatesController);
router.post('/confirm-prices', requireOwnerAccess, confirmMomentumCandidatePricesController);
router.post('/:id/confirm-price', requireOwnerAccess, confirmMomentumCandidatePriceController);
router.get('/:id/price-checks', requireOwnerAccess, listMomentumCandidatePriceChecksController);
router.get('/:id', requireOwnerAccess, getMomentumCandidateController);

export default router;

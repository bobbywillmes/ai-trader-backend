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
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, listMomentumCandidatesController);
router.post('/generate-from-catalysts', requireSystemOwnerAccess, generateMomentumCandidatesController);
router.post('/expire-stale', requireSystemOwnerAccess, expireStaleMomentumCandidatesController);
router.post('/confirm-prices', requireSystemOwnerAccess, confirmMomentumCandidatePricesController);
router.post('/:id/confirm-price', requireSystemOwnerAccess, confirmMomentumCandidatePriceController);
router.get('/:id/price-checks', requireSystemOwnerAccess, listMomentumCandidatePriceChecksController);
router.get('/:id', requireSystemOwnerAccess, getMomentumCandidateController);

export default router;

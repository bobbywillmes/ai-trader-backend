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

const router = Router();

router.get('/', listMomentumCandidatesController);
router.post('/generate-from-catalysts', generateMomentumCandidatesController);
router.post('/expire-stale', expireStaleMomentumCandidatesController);
router.post('/confirm-prices', confirmMomentumCandidatePricesController);
router.post('/:id/confirm-price', confirmMomentumCandidatePriceController);
router.get('/:id/price-checks', listMomentumCandidatePriceChecksController);
router.get('/:id', getMomentumCandidateController);

export default router;

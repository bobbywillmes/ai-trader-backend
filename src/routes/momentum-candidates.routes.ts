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
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listMomentumCandidatesController);
router.post('/generate-from-catalysts', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), generateMomentumCandidatesController);
router.post('/expire-stale', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), expireStaleMomentumCandidatesController);
router.post('/confirm-prices', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), confirmMomentumCandidatePricesController);
router.post('/:id/confirm-price', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), confirmMomentumCandidatePriceController);
router.get('/:id/price-checks', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listMomentumCandidatePriceChecksController);
router.get('/:id', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getMomentumCandidateController);

export default router;

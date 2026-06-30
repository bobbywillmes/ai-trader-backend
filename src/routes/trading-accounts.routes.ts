import { Router } from 'express';
import {
  createTradingAccountAllocationController,
  getTradingAccountController,
  listTradingAccountsController,
  listTradingAccountAllocationsController,
  updateTradingAccountController,
  updateTradingAccountAllocationController,
  upsertTradingAccountCredentialController,
  revokeTradingAccountCredentialController,
  verifyTradingAccountCredentialController,
} from '../controllers/trading-accounts.controller.js';

const router = Router();

router.get('/', listTradingAccountsController);
router.get('/:id', getTradingAccountController);
router.patch('/:id', updateTradingAccountController);
router.get('/:id/allocations', listTradingAccountAllocationsController);
router.post('/:id/allocations', createTradingAccountAllocationController);
router.patch(
  '/:id/allocations/:allocationId',
  updateTradingAccountAllocationController
);
router.put('/:id/credentials', upsertTradingAccountCredentialController);
router.post('/:id/credentials/verify', verifyTradingAccountCredentialController);
router.post('/:id/credentials/revoke', revokeTradingAccountCredentialController);

export default router;

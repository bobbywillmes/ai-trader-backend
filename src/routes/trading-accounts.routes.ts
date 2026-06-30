import { Router } from 'express';
import {
  createTradingAccountAllocationController,
  createTradingAccountSubscriptionController,
  getTradingAccountSubscriptionController,
  getTradingAccountController,
  listTradingAccountsController,
  listTradingAccountAllocationsController,
  listTradingAccountSubscriptionsController,
  updateTradingAccountController,
  updateTradingAccountAllocationController,
  updateTradingAccountSubscriptionController,
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
router.get(
  '/:id/account-subscriptions',
  listTradingAccountSubscriptionsController
);
router.get(
  '/:id/account-subscriptions/:accountSubscriptionId',
  getTradingAccountSubscriptionController
);
router.post(
  '/:id/account-subscriptions',
  createTradingAccountSubscriptionController
);
router.patch(
  '/:id/account-subscriptions/:accountSubscriptionId',
  updateTradingAccountSubscriptionController
);
router.put('/:id/credentials', upsertTradingAccountCredentialController);
router.post('/:id/credentials/verify', verifyTradingAccountCredentialController);
router.post('/:id/credentials/revoke', revokeTradingAccountCredentialController);

export default router;

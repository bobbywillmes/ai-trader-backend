import { Router } from 'express';
import {
  createTradingAccountAllocationController,
  createTradingAccountSubscriptionController,
  getTradingAccountRiskHealthController,
  getTradingAccountSubscriptionPriceHistoryController,
  getTradingAccountSubscriptionController,
  getTradingAccountController,
  getTradingAccountRiskSettingsController,
  listTradingAccountsController,
  listTradingAccountAllocationsController,
  listTradingAccountSubscriptionMarketContextController,
  listTradingAccountSubscriptionsController,
  previewTradingAccountEntryRiskController,
  updateTradingAccountController,
  updateTradingAccountAllocationController,
  updateTradingAccountRiskSettingsController,
  updateTradingAccountSubscriptionController,
  upsertTradingAccountCredentialController,
  revokeTradingAccountCredentialController,
  verifyTradingAccountCredentialController,
} from '../controllers/trading-accounts.controller.js';

const router = Router();

router.get('/', listTradingAccountsController);
router.get('/:id/risk-settings', getTradingAccountRiskSettingsController);
router.patch('/:id/risk-settings', updateTradingAccountRiskSettingsController);
router.get('/:id/risk-health', getTradingAccountRiskHealthController);
router.post('/:id/entry-risk-preview', previewTradingAccountEntryRiskController);
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
  '/:id/account-subscriptions/market-context',
  listTradingAccountSubscriptionMarketContextController
);
router.get(
  '/:id/account-subscriptions/:accountSubscriptionId/price-history',
  getTradingAccountSubscriptionPriceHistoryController
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

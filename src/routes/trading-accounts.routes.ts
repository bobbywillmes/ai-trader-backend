import { Router } from 'express';
import {
  createTradingAccountAllocationController,
  createTradingAccountSubscriptionController,
  getTradingAccountRiskHealthController,
  getTradingAccountSubscriptionPriceHistoryController,
  getTradingAccountSubscriptionController,
  getTradingAccountController,
  listTradingAccountOpenOrdersController,
  listTradingAccountOpenPositionsController,
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
import { requirePermission, requireTradingAccountAccess } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listTradingAccountsController);
router.get('/:id', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getTradingAccountController);
router.get('/:id/positions', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listTradingAccountOpenPositionsController);
router.get('/:id/orders', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listTradingAccountOpenOrdersController);
router.patch('/:id', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), updateTradingAccountController);

router.get('/:id/risk-settings', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getTradingAccountRiskSettingsController);
router.patch('/:id/risk-settings', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_RISK_WRITE), updateTradingAccountRiskSettingsController);
router.get('/:id/risk-health', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getTradingAccountRiskHealthController);
router.post('/:id/entry-risk-preview', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), previewTradingAccountEntryRiskController);

router.get('/:id/allocations', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listTradingAccountAllocationsController);
router.post('/:id/allocations', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), createTradingAccountAllocationController);
router.patch('/:id/allocations/:allocationId', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), updateTradingAccountAllocationController);

router.get('/:id/account-subscriptions', requireTradingAccountAccess('id'), requirePermission(AdminPermission.SUBSCRIPTION_READ), listTradingAccountSubscriptionsController);
router.get('/:id/account-subscriptions/market-context', requireTradingAccountAccess('id'), requirePermission(AdminPermission.SUBSCRIPTION_READ), listTradingAccountSubscriptionMarketContextController);
router.get('/:id/account-subscriptions/:accountSubscriptionId', requireTradingAccountAccess('id'), requirePermission(AdminPermission.SUBSCRIPTION_READ), getTradingAccountSubscriptionController);
router.get('/:id/account-subscriptions/:accountSubscriptionId/price-history', requireTradingAccountAccess('id'), requirePermission(AdminPermission.SUBSCRIPTION_READ), getTradingAccountSubscriptionPriceHistoryController);
router.post('/:id/account-subscriptions', requireTradingAccountAccess('id'), requirePermission(AdminPermission.SUBSCRIPTION_WRITE), createTradingAccountSubscriptionController);
router.patch('/:id/account-subscriptions/:accountSubscriptionId', requireTradingAccountAccess('id'), requirePermission(AdminPermission.SUBSCRIPTION_WRITE), updateTradingAccountSubscriptionController);

router.put('/:id/credentials', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), upsertTradingAccountCredentialController);
router.post('/:id/credentials/verify', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), verifyTradingAccountCredentialController);
router.post('/:id/credentials/revoke', requireTradingAccountAccess('id'), requirePermission(AdminPermission.TRADING_ACCOUNT_WRITE), revokeTradingAccountCredentialController);

export default router;

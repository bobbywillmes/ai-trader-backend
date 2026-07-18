import { Router } from 'express';
import {
  createTradingAccountAllocationController,
  createTradingAccountController,
  createTradingAccountSubscriptionController,
  getTradingAccountRiskHealthController,
  getTradingAccountSubscriptionPriceHistoryController,
  getTradingAccountSubscriptionController,
  getTradingAccountController,
  listTradingAccountOpenOrdersController,
  listTradingAccountOpenPositionsController,
  listTradingAccountTradeCyclesController,
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
import { requirePermission, requireSystemOwnerAccess, requireTradingAccountAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), listTradingAccountsController);
router.post('/', requireSystemOwnerAccess, createTradingAccountController);
router.get('/:id', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), getTradingAccountController);
router.get('/:id/positions', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), listTradingAccountOpenPositionsController);
router.get('/:id/orders', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), listTradingAccountOpenOrdersController);
router.get('/:id/trade-cycles', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.REPORTS_READ), listTradingAccountTradeCyclesController);
router.patch('/:id', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), updateTradingAccountController);

router.get('/:id/risk-settings', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_RISK_WRITE), getTradingAccountRiskSettingsController);
router.patch('/:id/risk-settings', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_RISK_WRITE), updateTradingAccountRiskSettingsController);
router.get('/:id/risk-health', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_RISK_WRITE), getTradingAccountRiskHealthController);
router.post('/:id/entry-risk-preview', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_RISK_WRITE), previewTradingAccountEntryRiskController);

router.get('/:id/allocations', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), listTradingAccountAllocationsController);
router.post('/:id/allocations', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), createTradingAccountAllocationController);
router.patch('/:id/allocations/:allocationId', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), updateTradingAccountAllocationController);

router.get('/:id/account-subscriptions', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.SUBSCRIPTION_READ), listTradingAccountSubscriptionsController);
router.get('/:id/account-subscriptions/market-context', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.SUBSCRIPTION_READ), listTradingAccountSubscriptionMarketContextController);
router.get('/:id/account-subscriptions/:accountSubscriptionId', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.SUBSCRIPTION_READ), getTradingAccountSubscriptionController);
router.get('/:id/account-subscriptions/:accountSubscriptionId/price-history', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.SUBSCRIPTION_READ), getTradingAccountSubscriptionPriceHistoryController);
router.post('/:id/account-subscriptions', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.SUBSCRIPTION_WRITE), createTradingAccountSubscriptionController);
router.patch('/:id/account-subscriptions/:accountSubscriptionId', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.SUBSCRIPTION_WRITE), updateTradingAccountSubscriptionController);

router.put('/:id/credentials', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), upsertTradingAccountCredentialController);
router.post('/:id/credentials/verify', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), verifyTradingAccountCredentialController);
router.post('/:id/credentials/revoke', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_WRITE), revokeTradingAccountCredentialController);

export default router;

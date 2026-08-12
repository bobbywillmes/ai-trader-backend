import { Router } from 'express';
import {
  closePositionController,
  closeScopedPositionController,
  scopedOpenPositionsController,
  positionsController,
} from '../controllers/positions.controller.js';
import {
  requirePermission,
  requireSystemOwnerAccess,
  requireTradingAccountAccess,
} from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

// Default account read requires owner access (no account-scoping)
router.get('/', requireSystemOwnerAccess, positionsController);
router.get('/open/scoped', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), scopedOpenPositionsController);
router.delete('/trading-accounts/:tradingAccountId/:trackedPositionId', requireSystemOwnerAccess, requireTradingAccountAccess('tradingAccountId'), closeScopedPositionController);
// The tracked-position identity resolves exactly one account and assignment.
router.delete(
  '/:trackedPositionId',
  requireSystemOwnerAccess,
  closePositionController
);

export default router;

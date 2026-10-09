import { Router } from 'express';
import { currentStrategyEligibilityController, strategyEligibilityDetailController, strategyEligibilityHistoryController } from '../controllers/strategy-market-eligibility.controller.js';
import {
  activateStrategyMarketPolicyRevisionController,
  createStrategyMarketPolicyController,
  prepareStrategyMarketPolicyRevisionController,
  strategiesController,
  strategyMarketPolicyController,
  strategyChangeImpactController,
  strategyController,
  saveStrategyMarketPolicyRevisionController,
  updateStrategyController,
  validateStrategyMarketPolicyRevisionController,
} from '../controllers/strategy.controller.js';
import {
  requirePermission,
  requireSystemOwnerAccess,
} from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.STRATEGY_READ), strategiesController);
router.get(
  '/:id/change-impact',
  requirePermission(PlatformPermission.STRATEGY_READ),
  strategyChangeImpactController,
);
router.patch('/:id', requireSystemOwnerAccess, updateStrategyController);
router.get('/:id/market-policy', requirePermission(PlatformPermission.STRATEGY_READ), strategyMarketPolicyController);
router.post('/:id/market-policy', requireSystemOwnerAccess, createStrategyMarketPolicyController);
router.post('/:id/market-policy/revisions', requireSystemOwnerAccess, prepareStrategyMarketPolicyRevisionController);
router.put('/:id/market-policy/revisions/:revisionId', requireSystemOwnerAccess, saveStrategyMarketPolicyRevisionController);
router.get('/:id/market-policy/revisions/:revisionId/validation', requirePermission(PlatformPermission.STRATEGY_READ), validateStrategyMarketPolicyRevisionController);
router.post('/:id/market-policy/revisions/:revisionId/activate', requireSystemOwnerAccess, activateStrategyMarketPolicyRevisionController);
router.get('/:id/market-eligibility/current', requirePermission(PlatformPermission.STRATEGY_READ), currentStrategyEligibilityController);
router.get('/:id/market-eligibility/decisions', requirePermission(PlatformPermission.STRATEGY_READ), strategyEligibilityHistoryController);
router.get('/:id/market-eligibility/decisions/:decisionId', requirePermission(PlatformPermission.STRATEGY_READ), strategyEligibilityDetailController);
router.get(
  '/:id',
  requirePermission(PlatformPermission.STRATEGY_READ),
  strategyController,
);

export default router;

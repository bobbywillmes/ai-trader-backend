import { Router } from 'express';
import {
  activateStrategyMarketPolicyRevisionController,
  createStrategyMarketPolicyController,
  prepareStrategyMarketPolicyRevisionController,
  strategiesController,
  strategyMarketPolicyController,
  strategyChangeImpactController,
  strategyController,
  updateStrategyMarketPolicyRuleController,
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
router.patch('/:id/market-policy/revisions/:revisionId/dimensions/:dimension', requireSystemOwnerAccess, updateStrategyMarketPolicyRuleController);
router.get('/:id/market-policy/revisions/:revisionId/validation', requirePermission(PlatformPermission.STRATEGY_READ), validateStrategyMarketPolicyRevisionController);
router.post('/:id/market-policy/revisions/:revisionId/activate', requireSystemOwnerAccess, activateStrategyMarketPolicyRevisionController);
router.get(
  '/:id',
  requirePermission(PlatformPermission.STRATEGY_READ),
  strategyController,
);

export default router;

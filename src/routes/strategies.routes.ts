import { Router } from 'express';
import {
  strategiesController,
  strategyChangeImpactController,
  strategyController,
  updateStrategyController,
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
router.get(
  '/:id',
  requirePermission(PlatformPermission.STRATEGY_READ),
  strategyController,
);

export default router;

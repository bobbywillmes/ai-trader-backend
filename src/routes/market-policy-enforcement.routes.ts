import { Router } from 'express';
import {
  activateMarketPolicyEnforcementRuntimeRolloutController,
  deactivateMarketPolicyEnforcementRuntimeRolloutController,
  getMarketPolicyBrokerEnforcementReadinessController,
  getMarketPolicyEnforcementRuntimeRolloutController,
  listMarketPolicyEnforcementRuntimeRolloutEventsController,
} from '../controllers/market-policy-enforcement.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

// PAPER-only runtime rollout for authoritative pre-intent market-policy enforcement. Status is
// readable through the existing administrative boundary; activation and deactivation are explicit
// SYSTEM_OWNER actions with durable audit evidence.
const router = Router();

router.get('/runtime-rollout', getMarketPolicyEnforcementRuntimeRolloutController);
router.get('/runtime-rollout/events', requireSystemOwnerAccess, listMarketPolicyEnforcementRuntimeRolloutEventsController);
router.post('/runtime-rollout/activate', requireSystemOwnerAccess, activateMarketPolicyEnforcementRuntimeRolloutController);
router.post('/runtime-rollout/deactivate', requireSystemOwnerAccess, deactivateMarketPolicyEnforcementRuntimeRolloutController);
router.get('/broker-time-readiness', requireSystemOwnerAccess, getMarketPolicyBrokerEnforcementReadinessController);

export default router;

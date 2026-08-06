import { Router } from 'express';

import {
  cancelLifecycleExerciseController,
  getLifecycleExerciseController,
  launchLifecycleExerciseController,
  listLifecycleExercisesController,
  listSubscriptionEntryCandidatesController,
  previewSubscriptionEntryLifecycleExerciseController,
  previewLifecycleExerciseController,
  reconcileLifecycleExerciseTargetController,
  recoverLifecycleExerciseDispatchesController,
} from '../controllers/trading-lifecycle-exercises.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/subscription-entry/candidates', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_READ), listSubscriptionEntryCandidatesController);
router.post('/subscription-entry/preview', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), previewSubscriptionEntryLifecycleExerciseController);
router.get('/', requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_READ), listLifecycleExercisesController);
router.get('/:id', requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_READ), getLifecycleExerciseController);
router.post('/preview', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), previewLifecycleExerciseController);
router.post('/:id/launch', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), launchLifecycleExerciseController);
router.post('/:id/dispatch-recovery', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), recoverLifecycleExerciseDispatchesController);
router.post('/:id/cancel', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), cancelLifecycleExerciseController);
router.post('/:exerciseId/targets/:targetId/reconciliation', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), reconcileLifecycleExerciseTargetController);

export default router;

import { Router } from 'express';

import {
  cancelLifecycleExerciseController,
  getLifecycleExerciseController,
  launchLifecycleExerciseController,
  listLifecycleExercisesController,
  previewLifecycleExerciseController,
  reconcileLifecycleExerciseTargetController,
} from '../controllers/trading-lifecycle-exercises.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_READ), listLifecycleExercisesController);
router.get('/:id', requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_READ), getLifecycleExerciseController);
router.post('/preview', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), previewLifecycleExerciseController);
router.post('/:id/launch', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), launchLifecycleExerciseController);
router.post('/:id/cancel', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), cancelLifecycleExerciseController);
router.post('/:exerciseId/targets/:targetId/reconciliation', requireSystemOwnerAccess, requirePermission(PlatformPermission.TRADING_LIFECYCLE_EXERCISE_WRITE), reconcileLifecycleExerciseTargetController);

export default router;

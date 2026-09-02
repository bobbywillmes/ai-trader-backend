import { Router } from 'express';

import {
  applyLifecycleRepairController,
  diagnoseLifecycleRepairController,
  getLifecycleRepairController,
  listLifecycleRepairsController,
  previewHistoricalEntryLifecycleController,
  decideLifecycleRepairActionController,
  applyLifecycleRepairActionController,
} from '../controllers/lifecycle-repairs.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();
router.use(requireSystemOwnerAccess);
router.get('/', listLifecycleRepairsController);
router.post('/diagnose', diagnoseLifecycleRepairController);
router.post('/historical-entry/preview', previewHistoricalEntryLifecycleController);
router.post('/actions/:actionId/decision', decideLifecycleRepairActionController);
router.post('/actions/:actionId/apply', applyLifecycleRepairActionController);
router.get('/:id', getLifecycleRepairController);
router.post('/:id/apply', applyLifecycleRepairController);
export default router;

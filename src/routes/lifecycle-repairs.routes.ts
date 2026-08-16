import { Router } from 'express';

import {
  applyLifecycleRepairController,
  diagnoseLifecycleRepairController,
  getLifecycleRepairController,
  listLifecycleRepairsController,
} from '../controllers/lifecycle-repairs.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();
router.use(requireSystemOwnerAccess);
router.get('/', listLifecycleRepairsController);
router.post('/diagnose', diagnoseLifecycleRepairController);
router.get('/:id', getLifecycleRepairController);
router.post('/:id/apply', applyLifecycleRepairController);
export default router;

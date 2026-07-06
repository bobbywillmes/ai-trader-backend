import { Router } from 'express';
import {
  tradeCycleByIdController,
  tradeCyclesController,
} from '../controllers/trade-cycles.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.REPORTS_READ), tradeCyclesController);
router.get('/:id', requirePermission(AdminPermission.REPORTS_READ), tradeCycleByIdController);

export default router;

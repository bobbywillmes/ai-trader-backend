import { Router } from 'express';
import {
  tradeCycleByIdController,
  tradeCyclesController,
} from '../controllers/trade-cycles.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.REPORTS_READ), tradeCyclesController);
router.get('/:id', requirePermission(PlatformPermission.REPORTS_READ), tradeCycleByIdController);

export default router;

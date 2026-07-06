import { Router } from 'express';
import { strategiesController } from '../controllers/subscription.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.STRATEGY_READ), strategiesController);

export default router;

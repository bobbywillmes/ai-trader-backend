import { Router } from 'express';
import { systemEventsController, getSecurityActivityController } from '../controllers/system-events.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.SYSTEM_EVENTS_READ), systemEventsController);
router.get('/security-activity/:symbol', requirePermission(AdminPermission.SYSTEM_EVENTS_READ), getSecurityActivityController);

export default router;
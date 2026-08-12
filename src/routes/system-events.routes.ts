import { Router } from 'express';
import { systemEventsController, getSecurityActivityController } from '../controllers/system-events.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.SYSTEM_EVENTS_READ), systemEventsController);
router.get('/security-activity/:symbol', requireSystemOwnerAccess, getSecurityActivityController);

export default router;

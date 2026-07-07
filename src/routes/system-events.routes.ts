import { Router } from 'express';
import { systemEventsController, getSecurityActivityController } from '../controllers/system-events.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, systemEventsController);
router.get('/security-activity/:symbol', requireOwnerAccess, getSecurityActivityController);

export default router;

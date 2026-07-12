import { Router } from 'express';
import { systemEventsController, getSecurityActivityController } from '../controllers/system-events.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, systemEventsController);
router.get('/security-activity/:symbol', requireSystemOwnerAccess, getSecurityActivityController);

export default router;

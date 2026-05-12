import { Router } from 'express';
import { systemEventsController, getSecurityActivityController } from '../controllers/system-events.controller.js';

const router = Router();

router.get('/', systemEventsController);
router.get('/security-activity/:symbol', getSecurityActivityController);

export default router;
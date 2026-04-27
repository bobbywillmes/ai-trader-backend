import { Router } from 'express';
import { systemEventsController } from '../controllers/system-events.controller.js';

const router = Router();

router.get('/', systemEventsController);

export default router;
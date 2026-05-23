import { Router } from 'express';
import { entrySignalController } from '../controllers/signals.controller.js';
import { openTrackedPositionsController } from '../controllers/tracked-positions.controller.js';

const router = Router();

router.get('/tracked-positions/open', openTrackedPositionsController);
router.post('/entry', entrySignalController);

export default router;
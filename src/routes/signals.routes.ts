import { Router } from 'express';
import { entrySignalController } from '../controllers/signals.controller.js';

const router = Router();

router.post('/entry', entrySignalController);

export default router;
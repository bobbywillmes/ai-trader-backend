import { Router } from 'express';
import { getSystemStatusController } from '../controllers/system-status.controller.js';

const router = Router();

router.get('/', getSystemStatusController);

export default router;
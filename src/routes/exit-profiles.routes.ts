import { Router } from 'express';
import { exitProfilesController } from '../controllers/subscription.controller.js';

const router = Router();

router.get('/', exitProfilesController);

export default router;
import { Router } from 'express';
import { strategiesController } from '../controllers/subscription.controller.js';

const router = Router();

router.get('/', strategiesController);

export default router;
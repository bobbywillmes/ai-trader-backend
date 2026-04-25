import { Router } from 'express';
import { orderIntentsController } from '../controllers/order-intents.controller.js';

const router = Router();

router.get('/', orderIntentsController);

export default router;
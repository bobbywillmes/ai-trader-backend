import { Router } from 'express';
import { openOrdersController } from '../controllers/orders.controller.js';

const router = Router();

router.get('/open', openOrdersController);

export default router;
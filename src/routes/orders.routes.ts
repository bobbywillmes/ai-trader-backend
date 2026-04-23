import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController
} from '../controllers/orders.controller.js';

const router = Router();

router.get('/open', openOrdersController);
router.post('/', placeOrderController);

export default router;
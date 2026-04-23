import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController
} from '../controllers/orders.controller.js';

const router = Router();

router.get('/open', openOrdersController);
router.post('/', placeOrderController);
router.delete('/:orderId', cancelOrderController);

export default router;
import { Router } from 'express';
import {
  openOrdersController,
  placeOrderController,
  cancelOrderController,
  cancelAllOrdersController
} from '../controllers/orders.controller.js';

const router = Router();

router.get('/open', openOrdersController);
router.post('/', placeOrderController);
router.delete('/', cancelAllOrdersController);
router.delete('/:orderId', cancelOrderController);

export default router;
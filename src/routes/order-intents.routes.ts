import { Router } from 'express';
import {
  orderIntentByIdController,
  orderIntentsController
} from '../controllers/order-intents.controller.js';

const router = Router();

router.get('/', orderIntentsController);
router.get('/:id', orderIntentByIdController);

export default router;
import { Router } from 'express';
import {
  tradeCycleByIdController,
  tradeCyclesController,
} from '../controllers/trade-cycles.controller.js';

const router = Router();

router.get('/', tradeCyclesController);
router.get('/:id', tradeCycleByIdController);

export default router;

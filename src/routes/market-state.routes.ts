import { Router } from 'express';
import {
  getCurrentMarketStateController,
  updateCurrentMarketStateController,
} from '../controllers/market-state.controller.js';

const router = Router();

router.get('/current', getCurrentMarketStateController);
router.patch('/current', updateCurrentMarketStateController);

export default router;
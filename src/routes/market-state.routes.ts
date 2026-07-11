import { Router } from 'express';
import {
  getCurrentMarketStateController,
  updateCurrentMarketStateController,
} from '../controllers/market-state.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/current', requireSystemOwnerAccess, getCurrentMarketStateController);
router.patch('/current', requireSystemOwnerAccess, updateCurrentMarketStateController);

export default router;

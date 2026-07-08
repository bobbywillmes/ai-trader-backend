import { Router } from 'express';
import {
  getCurrentMarketStateController,
  updateCurrentMarketStateController,
} from '../controllers/market-state.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/current', requireOwnerAccess, getCurrentMarketStateController);
router.patch('/current', requireOwnerAccess, updateCurrentMarketStateController);

export default router;

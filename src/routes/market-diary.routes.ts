import { Router } from 'express';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/events', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getMarketDiaryEventsController);
router.post('/events', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), createMarketDiaryEventController);

export default router;
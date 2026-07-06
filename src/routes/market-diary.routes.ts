import { Router } from 'express';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';
import { requirePermission, requireOwnerAccess } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/events', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getMarketDiaryEventsController);
// Market diary writes require owner access (not for delegation)
router.post('/events', requireOwnerAccess, createMarketDiaryEventController);

export default router;
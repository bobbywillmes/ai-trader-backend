import { Router } from 'express';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/events', requireOwnerAccess, getMarketDiaryEventsController);
// Market diary writes require owner access (not for delegation)
router.post('/events', requireOwnerAccess, createMarketDiaryEventController);

export default router;

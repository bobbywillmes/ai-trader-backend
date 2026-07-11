import { Router } from 'express';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/events', requireSystemOwnerAccess, getMarketDiaryEventsController);
// Market diary writes require owner access (not for delegation)
router.post('/events', requireSystemOwnerAccess, createMarketDiaryEventController);

export default router;

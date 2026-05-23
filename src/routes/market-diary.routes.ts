import { Router } from 'express';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';

const router = Router();

router.get('/events', getMarketDiaryEventsController);
router.post('/events', createMarketDiaryEventController);

export default router;
import { Router } from 'express';
import { entrySignalController } from '../controllers/signals.controller.js';
import { openTrackedPositionsController } from '../controllers/tracked-positions.controller.js';
import {
  getCurrentMarketStateController,
  updateCurrentMarketStateController,
} from '../controllers/market-state.controller.js';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';

const router = Router();

router.get('/tracked-positions/open', openTrackedPositionsController);
router.post('/entry', entrySignalController);

router.get('/market-state/current', getCurrentMarketStateController);
router.patch('/market-state/current', updateCurrentMarketStateController);

router.get('/market-diary/events', getMarketDiaryEventsController);
router.post('/market-diary/events', createMarketDiaryEventController);

export default router;
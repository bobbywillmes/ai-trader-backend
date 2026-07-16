import { Router } from 'express';
import {
  entryDecisionController,
  entrySignalController,
} from '../controllers/signals.controller.js';
import { openTrackedPositionsController } from '../controllers/tracked-positions.controller.js';
import {
  getCurrentMarketStateController,
  updateCurrentMarketStateController,
} from '../controllers/market-state.controller.js';
import {
  createMarketDiaryEventController,
  getMarketDiaryEventsController,
} from '../controllers/market-diary.controller.js';
import { getEtfWatchContextController } from '../controllers/etf-watch-context.controller.js';
import {
  confirmMomentumScannerPricesSignalController,
  expireMomentumScannerCandidatesSignalController,
  generateMomentumScannerCandidatesSignalController,
  listMomentumScannerHandoffsSignalController,
  markMomentumScannerHandoffFailedSignalController,
  markMomentumScannerHandoffSentSignalController,
  prepareMomentumScannerHandoffsSignalController,
  runMomentumScannerNewsWorkerSignalController,
} from '../controllers/momentum-scanner-signals.controller.js';

const router = Router();

router.get('/etf-watch/context', getEtfWatchContextController);

router.get('/tracked-positions/open', openTrackedPositionsController);
router.post('/entry-decisions', entryDecisionController);
router.post('/entry', entrySignalController);

router.get('/market-state/current', getCurrentMarketStateController);
router.patch('/market-state/current', updateCurrentMarketStateController);

router.get('/market-diary/events', getMarketDiaryEventsController);
router.post('/market-diary/events', createMarketDiaryEventController);

router.post('/momentum-scanner/run-news-worker', runMomentumScannerNewsWorkerSignalController);
router.post('/momentum-scanner/expire-candidates', expireMomentumScannerCandidatesSignalController);
router.post('/momentum-scanner/generate-candidates', generateMomentumScannerCandidatesSignalController);
router.post('/momentum-scanner/confirm-prices', confirmMomentumScannerPricesSignalController);
router.post('/momentum-scanner/prepare-handoffs', prepareMomentumScannerHandoffsSignalController);

router.get('/momentum-scanner/handoffs', listMomentumScannerHandoffsSignalController);

router.post('/momentum-scanner/handoffs/:id/mark-sent', markMomentumScannerHandoffSentSignalController);
router.post('/momentum-scanner/handoffs/:id/mark-failed', markMomentumScannerHandoffFailedSignalController);

export default router;

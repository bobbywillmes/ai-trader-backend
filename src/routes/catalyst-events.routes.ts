import { Router } from 'express';
import {
  getCatalystEventController,
  ingestMassiveNewsController,
  listCatalystEventsController,
  runMassiveNewsWorkerOnceController,
} from '../controllers/catalyst-events.controller.js';

const router = Router();

router.get('/', listCatalystEventsController);
router.post('/ingest/massive-news', ingestMassiveNewsController);
router.post(
  '/workers/massive-news/run-once',
  runMassiveNewsWorkerOnceController
);
router.get('/:id', getCatalystEventController);

export default router;

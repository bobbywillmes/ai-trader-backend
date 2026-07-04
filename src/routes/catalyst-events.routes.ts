import { Router } from 'express';
import {
  getCatalystEventController,
  ingestMassiveNewsController,
  listCatalystEventsController,
} from '../controllers/catalyst-events.controller.js';

const router = Router();

router.get('/', listCatalystEventsController);
router.get('/:id', getCatalystEventController);
router.post('/ingest/massive-news', ingestMassiveNewsController);

export default router;

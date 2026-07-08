import { Router } from 'express';
import {
  getCatalystEventController,
  ingestMassiveNewsController,
  listCatalystEventsController,
  runMassiveNewsWorkerOnceController,
} from '../controllers/catalyst-events.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, listCatalystEventsController);
router.post('/ingest/massive-news', requireOwnerAccess, ingestMassiveNewsController);
router.post(
  '/workers/massive-news/run-once',
  requireOwnerAccess,
  runMassiveNewsWorkerOnceController
);
router.get('/:id', requireOwnerAccess, getCatalystEventController);

export default router;

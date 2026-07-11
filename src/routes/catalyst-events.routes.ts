import { Router } from 'express';
import {
  getCatalystEventController,
  ingestMassiveNewsController,
  listCatalystEventsController,
  runMassiveNewsWorkerOnceController,
} from '../controllers/catalyst-events.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, listCatalystEventsController);
router.post('/ingest/massive-news', requireSystemOwnerAccess, ingestMassiveNewsController);
router.post(
  '/workers/massive-news/run-once',
  requireSystemOwnerAccess,
  runMassiveNewsWorkerOnceController
);
router.get('/:id', requireSystemOwnerAccess, getCatalystEventController);

export default router;

import { Router } from 'express';
import {
  getCatalystEventController,
  ingestMassiveNewsController,
  listCatalystEventsController,
  runMassiveNewsWorkerOnceController,
} from '../controllers/catalyst-events.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), listCatalystEventsController);
router.post('/ingest/massive-news', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), ingestMassiveNewsController);
router.post(
  '/workers/massive-news/run-once',
  requirePermission(AdminPermission.TRADING_ACCOUNT_READ),
  runMassiveNewsWorkerOnceController
);
router.get('/:id', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getCatalystEventController);

export default router;

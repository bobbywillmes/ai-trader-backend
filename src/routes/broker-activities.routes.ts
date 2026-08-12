import { Router } from 'express';
import {
  getBrokerActivitiesController,
  getLatestBrokerActivityController,
  syncBrokerActivitiesController,
} from '../controllers/broker-activities.controller.js';
import { requirePermission, requireSystemOwnerAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();

router.get('/', requirePermission(PlatformPermission.REPORTS_READ), getBrokerActivitiesController);
router.get('/latest', requireSystemOwnerAccess, getLatestBrokerActivityController);
// Broker sync is a maintenance operation, requires owner access
router.post('/sync', requireSystemOwnerAccess, syncBrokerActivitiesController);

export default router;

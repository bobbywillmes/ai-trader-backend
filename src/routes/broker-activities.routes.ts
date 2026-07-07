import { Router } from 'express';
import {
  getBrokerActivitiesController,
  getLatestBrokerActivityController,
  syncBrokerActivitiesController,
} from '../controllers/broker-activities.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, getBrokerActivitiesController);
router.get('/latest', requireOwnerAccess, getLatestBrokerActivityController);
// Broker sync is a maintenance operation, requires owner access
router.post('/sync', requireOwnerAccess, syncBrokerActivitiesController);

export default router;

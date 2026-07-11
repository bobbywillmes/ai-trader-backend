import { Router } from 'express';
import {
  getBrokerActivitiesController,
  getLatestBrokerActivityController,
  syncBrokerActivitiesController,
} from '../controllers/broker-activities.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, getBrokerActivitiesController);
router.get('/latest', requireSystemOwnerAccess, getLatestBrokerActivityController);
// Broker sync is a maintenance operation, requires owner access
router.post('/sync', requireSystemOwnerAccess, syncBrokerActivitiesController);

export default router;

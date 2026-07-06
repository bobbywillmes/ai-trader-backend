import { Router } from 'express';
import {
  getBrokerActivitiesController,
  getLatestBrokerActivityController,
  syncBrokerActivitiesController,
} from '../controllers/broker-activities.controller.js';
import { requirePermission, requireOwnerAccess } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getBrokerActivitiesController);
router.get('/latest', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getLatestBrokerActivityController);
// Broker sync is a maintenance operation, requires owner access
router.post('/sync', requireOwnerAccess, syncBrokerActivitiesController);

export default router;
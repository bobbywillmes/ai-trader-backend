import { Router } from 'express';
import {
  getBrokerActivitiesController,
  getLatestBrokerActivityController,
  syncBrokerActivitiesController,
} from '../controllers/broker-activities.controller.js';

const router = Router();

router.get('/', getBrokerActivitiesController);
router.get('/latest', getLatestBrokerActivityController);
router.post('/sync', syncBrokerActivitiesController);

export default router;
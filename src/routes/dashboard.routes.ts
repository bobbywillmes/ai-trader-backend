import { Router } from 'express';
import {
  getIndexIntradayController,
  getIndexPerformanceController,
} from '../controllers/dashboard.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/index-performance', requireOwnerAccess, getIndexPerformanceController);
router.get('/index-intraday', requireOwnerAccess, getIndexIntradayController);

export default router;

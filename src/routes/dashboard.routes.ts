import { Router } from 'express';
import {
  getIndexIntradayController,
  getIndexPerformanceController,
} from '../controllers/dashboard.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/index-performance', requireSystemOwnerAccess, getIndexPerformanceController);
router.get('/index-intraday', requireSystemOwnerAccess, getIndexIntradayController);

export default router;

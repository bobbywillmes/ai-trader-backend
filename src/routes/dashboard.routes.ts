import { Router } from 'express';
import {
  getIndexIntradayController,
  getIndexPerformanceController,
} from '../controllers/dashboard.controller.js';

const router = Router();

router.get('/index-performance', getIndexPerformanceController);
router.get('/index-intraday', getIndexIntradayController);

export default router;

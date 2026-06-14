import { Router } from 'express';
import { tradePerformanceController } from '../controllers/trade-performance.controller.js';

const router = Router();

router.get('/', tradePerformanceController);

export default router;

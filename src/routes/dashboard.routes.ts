import { Router } from 'express';
import { getIndexPerformanceController } from '../controllers/dashboard.controller.js';

const router = Router();

router.get('/index-performance', getIndexPerformanceController);

export default router;

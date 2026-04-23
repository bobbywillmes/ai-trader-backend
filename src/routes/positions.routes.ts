import { Router } from 'express';
import { positionsController } from '../controllers/positions.controller.js';

const router = Router();

router.get('/', positionsController);

export default router;
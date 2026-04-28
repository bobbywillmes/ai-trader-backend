import { Router } from 'express';
import { trackedPositionsController } from '../controllers/tracked-positions.controller.js';

const router = Router();

router.get('/', trackedPositionsController);

export default router;
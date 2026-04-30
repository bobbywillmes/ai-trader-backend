import { Router } from 'express';
import { 
  openTrackedPositionsController,
  trackedPositionsController
} from '../controllers/tracked-positions.controller.js';

const router = Router();

router.get('/open', openTrackedPositionsController);
router.get('/', trackedPositionsController);

export default router;
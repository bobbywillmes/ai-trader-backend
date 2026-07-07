import { Router } from 'express';
import {
  openTrackedPositionsController,
  trackedPositionsController
} from '../controllers/tracked-positions.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/open', requireOwnerAccess, openTrackedPositionsController);
router.get('/', requireOwnerAccess, trackedPositionsController);

export default router;

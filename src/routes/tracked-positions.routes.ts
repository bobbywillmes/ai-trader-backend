import { Router } from 'express';
import {
  openTrackedPositionsController,
  trackedPositionsController
} from '../controllers/tracked-positions.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/open', requireSystemOwnerAccess, openTrackedPositionsController);
router.get('/', requireSystemOwnerAccess, trackedPositionsController);

export default router;

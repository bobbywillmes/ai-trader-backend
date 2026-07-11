import { Router } from 'express';
import {
  tradeCycleByIdController,
  tradeCyclesController,
} from '../controllers/trade-cycles.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, tradeCyclesController);
router.get('/:id', requireSystemOwnerAccess, tradeCycleByIdController);

export default router;

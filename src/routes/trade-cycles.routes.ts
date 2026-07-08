import { Router } from 'express';
import {
  tradeCycleByIdController,
  tradeCyclesController,
} from '../controllers/trade-cycles.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, tradeCyclesController);
router.get('/:id', requireOwnerAccess, tradeCycleByIdController);

export default router;

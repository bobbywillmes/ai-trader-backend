import { Router } from 'express';
import {
  entryDecisionByIdController,
  entryDecisionsController,
} from '../controllers/entry-decisions.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, entryDecisionsController);
router.get('/:id', requireSystemOwnerAccess, entryDecisionByIdController);

export default router;

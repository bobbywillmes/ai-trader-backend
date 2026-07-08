import { Router } from 'express';
import {
  entryDecisionByIdController,
  entryDecisionsController,
} from '../controllers/entry-decisions.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, entryDecisionsController);
router.get('/:id', requireOwnerAccess, entryDecisionByIdController);

export default router;

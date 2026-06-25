import { Router } from 'express';
import {
  entryDecisionByIdController,
  entryDecisionsController,
} from '../controllers/entry-decisions.controller.js';

const router = Router();

router.get('/', entryDecisionsController);
router.get('/:id', entryDecisionByIdController);

export default router;

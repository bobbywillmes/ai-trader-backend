import { Router } from 'express';
import {
  exitProfilesController,
  createExitProfileController,
  updateExitProfileController,
} from '../controllers/subscription.controller.js';

const router = Router();

router.get('/', exitProfilesController);
router.post('/', createExitProfileController);
router.patch('/:id', updateExitProfileController);

export default router;
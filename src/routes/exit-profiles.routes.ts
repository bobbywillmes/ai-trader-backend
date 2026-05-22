import { Router } from 'express';
import { 
  getAllExitProfilesController,
  findExitProfileController,
  createExitProfileController,
  updateExitProfileController
 } from '../controllers/exit-profiles.controller.js';

const router = Router();

router.get('/', getAllExitProfilesController);
router.get('/:key', findExitProfileController);
router.post('/', createExitProfileController);
router.patch('/:key', updateExitProfileController);

export default router;
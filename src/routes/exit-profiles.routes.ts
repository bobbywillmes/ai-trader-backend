import { Router } from 'express';
import {
  getAllExitProfilesController,
  findExitProfileController,
  createExitProfileController,
  updateExitProfileController
 } from '../controllers/exit-profiles.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, getAllExitProfilesController);
router.get('/:key', requireOwnerAccess, findExitProfileController);
router.post('/', requireOwnerAccess, createExitProfileController);
router.patch('/:key', requireOwnerAccess, updateExitProfileController);

export default router;

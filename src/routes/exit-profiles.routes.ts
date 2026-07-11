import { Router } from 'express';
import {
  getAllExitProfilesController,
  findExitProfileController,
  createExitProfileController,
  updateExitProfileController
 } from '../controllers/exit-profiles.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, getAllExitProfilesController);
router.get('/:key', requireSystemOwnerAccess, findExitProfileController);
router.post('/', requireSystemOwnerAccess, createExitProfileController);
router.patch('/:key', requireSystemOwnerAccess, updateExitProfileController);

export default router;

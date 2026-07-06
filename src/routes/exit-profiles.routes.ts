import { Router } from 'express';
import {
  getAllExitProfilesController,
  findExitProfileController,
  createExitProfileController,
  updateExitProfileController
 } from '../controllers/exit-profiles.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/', requirePermission(AdminPermission.EXIT_PROFILE_READ), getAllExitProfilesController);
router.get('/:key', requirePermission(AdminPermission.EXIT_PROFILE_READ), findExitProfileController);
router.post('/', requirePermission(AdminPermission.EXIT_PROFILE_WRITE), createExitProfileController);
router.patch('/:key', requirePermission(AdminPermission.EXIT_PROFILE_WRITE), updateExitProfileController);

export default router;
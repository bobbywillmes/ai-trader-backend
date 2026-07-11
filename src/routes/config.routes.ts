import { Router } from 'express';
import {
  getConfigController,
  updateSettingsController
} from '../controllers/config.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, getConfigController);
router.patch('/settings', requireSystemOwnerAccess, updateSettingsController);

export default router;
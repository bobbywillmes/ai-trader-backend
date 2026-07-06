import { Router } from 'express';
import {
  getConfigController,
  updateSettingsController
} from '../controllers/config.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, getConfigController);
router.patch('/settings', requireOwnerAccess, updateSettingsController);

export default router;
import { Router } from 'express';
import {
  getConfigController,
  updateSettingsController
} from '../controllers/config.controller.js';

const router = Router();

router.get('/', getConfigController);
router.patch('/settings', updateSettingsController);

export default router;
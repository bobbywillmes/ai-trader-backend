import { Router } from 'express';
import {
  adminBootstrapController,
  adminLoginController,
  adminLogoutController,
  adminMeController,
} from '../controllers/admin-auth.controller.js';
import { requireAdminApiKey } from '../middleware/api-key-auth.js';

const router = Router();

router.post('/bootstrap', requireAdminApiKey, adminBootstrapController);
router.post('/login', adminLoginController);
router.get('/me', adminMeController);
router.post('/logout', adminLogoutController);

export default router;
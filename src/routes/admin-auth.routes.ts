import { Router } from 'express';
import {
  adminBootstrapController,
  adminLoginController,
  adminLogoutController,
  adminMeController,
  adminChangePasswordController,
  adminVerifyPasswordController,
} from '../controllers/admin-auth.controller.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';

const router = Router();

router.post('/bootstrap', adminBootstrapController);
router.post('/login', adminLoginController);
router.get('/me', adminMeController);
router.post('/logout', adminLogoutController);
router.post('/verify-password', requireAdminAccess, adminVerifyPasswordController);
router.post('/change-password', requireAdminAccess, adminChangePasswordController);

export default router;
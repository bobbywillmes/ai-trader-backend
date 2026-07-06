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
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.post('/bootstrap', requireAdminAccess, requireOwnerAccess, adminBootstrapController);
router.post('/login', adminLoginController);
router.get('/me', adminMeController);
router.post('/logout', adminLogoutController);
router.post('/verify-password', requireAdminAccess, requireOwnerAccess, adminVerifyPasswordController);
router.post('/change-password', requireAdminAccess, requireOwnerAccess, adminChangePasswordController);

export default router;
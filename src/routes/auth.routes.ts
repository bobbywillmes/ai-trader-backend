import { Router } from 'express';
import {
  bootstrapController,
  loginController,
  logoutController,
  meController,
  changePasswordController,
  verifyPasswordController,
  completeSetupController,
  validateSetupTokenController,
} from '../controllers/auth.controller.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.post('/bootstrap', requireAdminAccess, requireOwnerAccess, bootstrapController);
router.post('/login', loginController);
router.get('/setup/:token', validateSetupTokenController);
router.post('/setup/:token', completeSetupController);
router.get('/me', meController);
router.post('/logout', logoutController);
router.post('/verify-password', requireAdminAccess, requireOwnerAccess, verifyPasswordController);
router.post('/change-password', requireAdminAccess, requireOwnerAccess, changePasswordController);

export default router;

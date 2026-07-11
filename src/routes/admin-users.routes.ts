import { Router } from 'express';
import {
  createAdminUserInvitationController,
  listAdminUsersController,
  getAdminUserController,
  getAdminUserTradingAccountAccessController,
  regenerateAdminUserSetupLinkController,
  updateAdminUserController,
  updateAdminUserTradingAccountAccessController,
  upsertTradingAccountAccessController,
} from '../controllers/admin-users.controller.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireAdminAccess, requireSystemOwnerAccess, listAdminUsersController);
router.post('/invitations', requireAdminAccess, requireSystemOwnerAccess, createAdminUserInvitationController);
router.post('/:id/setup-link', requireAdminAccess, requireSystemOwnerAccess, regenerateAdminUserSetupLinkController);
router.get('/:id', requireAdminAccess, requireSystemOwnerAccess, getAdminUserController);
router.patch('/:id', requireAdminAccess, requireSystemOwnerAccess, updateAdminUserController);
router.get('/:id/trading-account-access', requireAdminAccess, requireSystemOwnerAccess, getAdminUserTradingAccountAccessController);
router.put('/:id/trading-account-access', requireAdminAccess, requireSystemOwnerAccess, updateAdminUserTradingAccountAccessController);
router.put('/:id/trading-account-access/:accountId', requireAdminAccess, requireSystemOwnerAccess, upsertTradingAccountAccessController);

export default router;

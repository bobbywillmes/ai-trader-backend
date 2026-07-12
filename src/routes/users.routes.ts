import { Router } from 'express';

import {
  createUserInvitationController,
  getUserController,
  listUsersController,
  listUserTradingAccountMembershipsController,
  regenerateUserSetupLinkController,
  replaceUserTradingAccountMembershipsController,
  updateUserController,
} from '../controllers/users.controller.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.use(requireAdminAccess, requireSystemOwnerAccess);
router.get('/', listUsersController);
router.post('/invitations', createUserInvitationController);
router.post('/:id/setup-link', regenerateUserSetupLinkController);
router.get('/:id', getUserController);
router.patch('/:id', updateUserController);
router.get('/:id/trading-account-memberships', listUserTradingAccountMembershipsController);
router.put('/:id/trading-account-memberships', replaceUserTradingAccountMembershipsController);

export default router;

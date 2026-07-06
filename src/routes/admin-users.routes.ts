import { Router } from 'express';
import {
  listAdminUsersController,
  getAdminUserController,
  getAdminUserTradingAccountAccessController,
} from '../controllers/admin-users.controller.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireAdminAccess, requireOwnerAccess, listAdminUsersController);
router.get('/:id', requireAdminAccess, requireOwnerAccess, getAdminUserController);
router.get('/:id/trading-account-access', requireAdminAccess, requireOwnerAccess, getAdminUserTradingAccountAccessController);

export default router;

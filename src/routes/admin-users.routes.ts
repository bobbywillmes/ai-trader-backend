import { Router } from 'express';
import {
  listAdminUsersController,
  getAdminUserController,
  getAdminUserTradingAccountAccessController,
  updateAdminUserController,
  upsertTradingAccountAccessController,
} from '../controllers/admin-users.controller.js';
import { requireAdminAccess } from '../middleware/api-key-auth.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireAdminAccess, requireOwnerAccess, listAdminUsersController);
router.get('/:id', requireAdminAccess, requireOwnerAccess, getAdminUserController);
router.patch('/:id', requireAdminAccess, requireOwnerAccess, updateAdminUserController);
router.get('/:id/trading-account-access', requireAdminAccess, requireOwnerAccess, getAdminUserTradingAccountAccessController);
router.put('/:id/trading-account-access/:accountId', requireAdminAccess, requireOwnerAccess, upsertTradingAccountAccessController);

export default router;

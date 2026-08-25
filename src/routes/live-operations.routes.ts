import { Router } from 'express';
import { getLiveOperationsController } from '../controllers/live-operations.controller.js';
import { requirePermission, requireTradingAccountAccess } from '../middleware/rbac.js';
import { PlatformPermission } from '../types/platform-rbac.js';

const router = Router();
router.get('/', requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), getLiveOperationsController);
router.get('/:id', requireTradingAccountAccess('id'), requirePermission(PlatformPermission.TRADING_ACCOUNT_READ), getLiveOperationsController);
export default router;

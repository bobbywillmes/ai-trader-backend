import { Router } from 'express';
import { getEtfWatchContextController } from '../controllers/etf-watch-context.controller.js';
import { requirePermission } from '../middleware/rbac.js';
import { AdminPermission } from '../types/admin-rbac.js';

const router = Router();

router.get('/context', requirePermission(AdminPermission.TRADING_ACCOUNT_READ), getEtfWatchContextController);

export default router;
import { Router } from 'express';
import { getEtfWatchContextController } from '../controllers/etf-watch-context.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/context', requireOwnerAccess, getEtfWatchContextController);

export default router;

import { Router } from 'express';
import { getEtfWatchContextController } from '../controllers/etf-watch-context.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/context', requireSystemOwnerAccess, getEtfWatchContextController);

export default router;

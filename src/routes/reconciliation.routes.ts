import { Router } from 'express';

import { runReconciliationController } from '../controllers/reconciliation.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.post('/run', requireOwnerAccess, runReconciliationController);

export default router;
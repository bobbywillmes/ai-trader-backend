import { Router } from 'express';

import { runReconciliationController } from '../controllers/reconciliation.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.post('/run', requireSystemOwnerAccess, runReconciliationController);

export default router;
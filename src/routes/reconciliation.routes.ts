import { Router } from 'express';

import { runReconciliationController } from '../controllers/reconciliation.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

// Legacy SYSTEM_OWNER compatibility endpoint. Current UI reconciliation uses
// POST /api/trading-accounts/:id/reconciliation/run with route-owned identity.
router.post('/run', requireSystemOwnerAccess, runReconciliationController);

export default router;

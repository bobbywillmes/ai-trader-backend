import { Router } from 'express';

import { runReconciliationController } from '../controllers/reconciliation.controller.js';

const router = Router();

router.post('/run', runReconciliationController);

export default router;
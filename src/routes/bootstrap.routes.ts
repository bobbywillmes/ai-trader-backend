import { Router } from 'express';
import { bootstrapController } from '../controllers/bootstrap.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

// Legacy SYSTEM_OWNER compatibility endpoint. The Admin Console does not consume
// this default-TradingAccount response; use explicit account operational routes.
router.get('/', requireSystemOwnerAccess, bootstrapController);

export default router;

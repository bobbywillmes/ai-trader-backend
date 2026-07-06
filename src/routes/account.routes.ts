import { Router } from 'express';
import { accountController } from '../controllers/account.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, accountController);

export default router;
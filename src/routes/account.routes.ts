import { Router } from 'express';
import { accountController } from '../controllers/account.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, accountController);

export default router;
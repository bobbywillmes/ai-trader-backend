import { Router } from 'express';
import { bootstrapController } from '../controllers/bootstrap.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, bootstrapController);

export default router;
import { Router } from 'express';
import { bootstrapController } from '../controllers/bootstrap.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, bootstrapController);

export default router;
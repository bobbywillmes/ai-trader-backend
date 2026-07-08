import { Router } from 'express';
import { strategiesController } from '../controllers/subscription.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireOwnerAccess, strategiesController);

export default router;

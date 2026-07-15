import { Router } from 'express';
import { strategiesController } from '../controllers/strategy.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/', requireSystemOwnerAccess, strategiesController);

export default router;

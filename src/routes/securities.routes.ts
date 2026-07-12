import { Router } from 'express';
import {
  getAllSecuritiesController,
  getSecuritiesSummaryController,
  findSecurityController,
  addSecurityController,
  updateSecurityController,
} from '../controllers/securities.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/summary', requireSystemOwnerAccess, getSecuritiesSummaryController);
router.get('/', requireSystemOwnerAccess, getAllSecuritiesController);
router.get('/:symbol', requireSystemOwnerAccess, findSecurityController);
router.post('/', requireSystemOwnerAccess, addSecurityController);
router.patch('/:symbol', requireSystemOwnerAccess, updateSecurityController);

export default router;

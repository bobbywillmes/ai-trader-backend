import { Router } from 'express';
import {
  getAllSecuritiesController,
  getSecuritiesSummaryController,
  findSecurityController,
  addSecurityController,
  updateSecurityController,
} from '../controllers/securities.controller.js';
import { requireOwnerAccess } from '../middleware/rbac.js';

const router = Router();

router.get('/summary', requireOwnerAccess, getSecuritiesSummaryController);
router.get('/', requireOwnerAccess, getAllSecuritiesController);
router.get('/:symbol', requireOwnerAccess, findSecurityController);
router.post('/', requireOwnerAccess, addSecurityController);
router.patch('/:symbol', requireOwnerAccess, updateSecurityController);

export default router;

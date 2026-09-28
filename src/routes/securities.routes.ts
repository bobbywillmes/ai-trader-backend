import { Router } from 'express';
import {
  getAllSecuritiesController,
  getSecuritiesSummaryController,
  findSecurityController,
  addSecurityController,
  updateSecurityController,
} from '../controllers/securities.controller.js';
import { requireSystemOwnerAccess } from '../middleware/rbac.js';
import { importController, freezeController, exportController, breadthStatusController } from '../controllers/security-universe.controller.js';

const router = Router();

router.post('/universe-import/preview', requireSystemOwnerAccess, importController(false));
router.post('/universe-import/apply', requireSystemOwnerAccess, importController(true));
router.get('/exports/universe-snapshot', requireSystemOwnerAccess, exportController('universe-snapshot'));
router.get('/exports/security-catalog', requireSystemOwnerAccess, exportController('security-catalog'));
router.post('/breadth-revision/preview', requireSystemOwnerAccess, freezeController(false));
router.post('/breadth-revision/freeze', requireSystemOwnerAccess, freezeController(true));
router.get('/breadth-revision/status', requireSystemOwnerAccess, breadthStatusController);

router.get('/summary', requireSystemOwnerAccess, getSecuritiesSummaryController);
router.get('/', requireSystemOwnerAccess, getAllSecuritiesController);
router.get('/:symbol', requireSystemOwnerAccess, findSecurityController);
router.post('/', requireSystemOwnerAccess, addSecurityController);
router.patch('/:symbol', requireSystemOwnerAccess, updateSecurityController);

export default router;

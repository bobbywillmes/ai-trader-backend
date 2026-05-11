import { Router } from 'express';
import {
  getAllSecuritiesController,
  getSecuritiesSummaryController,
  findSecurityController,
  addSecurityController,
  updateSecurityController,
} from '../controllers/securities.controller.js';

const router = Router();

router.get('/summary', getSecuritiesSummaryController);
router.get('/', getAllSecuritiesController);
router.get('/:symbol', findSecurityController);
router.post('/', addSecurityController);
router.patch('/:symbol', updateSecurityController);

export default router;
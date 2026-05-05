import { Router } from 'express';
import {
  addSecurityController,
  findSecurityController,
  getAllSecuritiesController,
  updateSecurityController
} from '../controllers/securities.controller.js';

const router = Router();

router.get('/', getAllSecuritiesController);
router.get('/:symbol', findSecurityController);
router.post('/', addSecurityController);
router.patch('/:symbol', updateSecurityController);

export default router;
import { Router } from 'express';
import {
  getTradingAccountController,
  listTradingAccountsController,
  updateTradingAccountController,
} from '../controllers/trading-accounts.controller.js';

const router = Router();

router.get('/', listTradingAccountsController);
router.get('/:id', getTradingAccountController);
router.patch('/:id', updateTradingAccountController);

export default router;

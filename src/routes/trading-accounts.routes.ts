import { Router } from 'express';
import {
  getTradingAccountController,
  listTradingAccountsController,
} from '../controllers/trading-accounts.controller.js';

const router = Router();

router.get('/', listTradingAccountsController);
router.get('/:id', getTradingAccountController);

export default router;

import { Router } from 'express';
import {
  getTradingAccountController,
  listTradingAccountsController,
  updateTradingAccountController,
  upsertTradingAccountCredentialController,
} from '../controllers/trading-accounts.controller.js';

const router = Router();

router.get('/', listTradingAccountsController);
router.get('/:id', getTradingAccountController);
router.patch('/:id', updateTradingAccountController);
router.put('/:id/credentials', upsertTradingAccountCredentialController);

export default router;

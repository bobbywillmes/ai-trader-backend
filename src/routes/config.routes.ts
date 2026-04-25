import { Router } from 'express';
import {
  addAllowedTickerController,
  getAllowedTickersController,
  getConfigController,
  removeAllowedTickerController,
  updateSettingsController
} from '../controllers/config.controller.js';

const router = Router();

router.get('/', getConfigController);
router.patch('/settings', updateSettingsController);

router.get('/allowed-tickers', getAllowedTickersController);
router.post('/allowed-tickers', addAllowedTickerController);
router.delete('/allowed-tickers/:symbol', removeAllowedTickerController);

export default router;
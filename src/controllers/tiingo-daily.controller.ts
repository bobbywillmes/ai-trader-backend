import { marketController } from './market-data.controller.js';
import { tiingoDailyStatus } from '../services/tiingo-daily.service.js';

export const tiingoDailyStatusController = marketController(async (_req, res) => { res.json(await tiingoDailyStatus()); });

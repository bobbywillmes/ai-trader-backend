import { marketController } from './market-data.controller.js';
import { getMarketIntelligenceSummary } from '../services/market-intelligence.service.js';

export const marketIntelligenceSummaryController = marketController(async (_req, res) => {
  res.json(await getMarketIntelligenceSummary());
});

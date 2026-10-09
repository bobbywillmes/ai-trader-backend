import { z } from 'zod';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { marketController } from './market-data.controller.js';
import {
  currentMarketRegimeComposition,
  getMarketRegimeComposition,
  listMarketRegimeCompositions,
  marketRegimeCompositionStatus,
  publishMarketRegimeComposition,
} from '../services/market-regime-composition-publication.service.js';

export const marketRegimeCompositionCurrentController = marketController(async (_req, res) => {
  res.json(await currentMarketRegimeComposition());
});
export const marketRegimeCompositionStatusController = marketController(async (_req, res) => {
  res.json(await marketRegimeCompositionStatus());
});
export const marketRegimeCompositionListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listMarketRegimeCompositions(query.limit, query.beforeId));
});
export const marketRegimeCompositionDetailController = marketController(async (req, res) => {
  res.json(await getMarketRegimeComposition(marketIdSchema.parse(req.params.id)));
});
export const marketRegimeCompositionRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await publishMarketRegimeComposition());
});

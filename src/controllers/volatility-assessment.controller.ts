import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { getVolatilityAssessment, latestVolatilityAssessment, listVolatilityAssessments, publishVolatilityAssessments } from '../services/volatility-assessment.service.js';

export const volatilityAssessmentLatestController = marketController(async (_req, res) => { res.json(await latestVolatilityAssessment()); });
export const volatilityAssessmentListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listVolatilityAssessments(query.limit, query.beforeId));
});
export const volatilityAssessmentDetailController = marketController(async (req, res) => { res.json(await getVolatilityAssessment(marketIdSchema.parse(req.params.id))); });
export const volatilityAssessmentRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await publishVolatilityAssessments());
});

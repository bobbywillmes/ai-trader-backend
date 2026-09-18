import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { getTrendAssessment, latestTrendAssessment, listTrendAssessments, publishTrendAssessments } from '../services/trend-assessment.service.js';

export const trendAssessmentLatestController = marketController(async (_req, res) => { res.json(await latestTrendAssessment()); });
export const trendAssessmentListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listTrendAssessments(query.limit, query.beforeId));
});
export const trendAssessmentDetailController = marketController(async (req, res) => { res.json(await getTrendAssessment(marketIdSchema.parse(req.params.id))); });
export const trendAssessmentRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await publishTrendAssessments());
});

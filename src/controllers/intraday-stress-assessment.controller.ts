import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { getIntradayStressAssessment, latestIntradayStressAssessment, listIntradayStressAssessments, publishIntradayStressAssessments } from '../services/intraday-stress-assessment.service.js';

export const intradayStressAssessmentLatestController = marketController(async (_req, res) => { res.json(await latestIntradayStressAssessment()); });
export const intradayStressAssessmentListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listIntradayStressAssessments(query.limit, query.beforeId));
});
export const intradayStressAssessmentDetailController = marketController(async (req, res) => { res.json(await getIntradayStressAssessment(marketIdSchema.parse(req.params.id))); });
export const intradayStressAssessmentRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await publishIntradayStressAssessments());
});

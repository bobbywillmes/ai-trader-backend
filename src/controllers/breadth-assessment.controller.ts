import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { getBreadthV1Assessment, latestBreadthV1Assessment, listBreadthV1Assessments, publishBreadthV1Assessments } from '../services/breadth-v1-assessment.service.js';

export const breadthAssessmentLatestController = marketController(async (_req, res) => { res.json(await latestBreadthV1Assessment()); });
export const breadthAssessmentListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listBreadthV1Assessments(query.limit, query.beforeId));
});
export const breadthAssessmentDetailController = marketController(async (req, res) => { res.json(await getBreadthV1Assessment(marketIdSchema.parse(req.params.id))); });
export const breadthAssessmentRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await publishBreadthV1Assessments());
});

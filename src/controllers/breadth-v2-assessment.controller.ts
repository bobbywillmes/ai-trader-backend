import { z } from 'zod';
import { marketController } from './market-data.controller.js';
import { marketIdSchema } from '../validators/market-data.schema.js';
import { HttpError } from '../errors/http-error.js';
import { breadthV2AssessmentStatus, getBreadthV2Assessment, latestBreadthV2Assessment, listBreadthV2Assessments, publishBreadthV2Assessments } from '../services/breadth-v2-assessment.service.js';

export const breadthV2AssessmentStatusController = marketController(async (_req, res) => { res.json(await breadthV2AssessmentStatus()); });
export const breadthV2AssessmentLatestController = marketController(async (_req, res) => { res.json(await latestBreadthV2Assessment()); });
export const breadthV2AssessmentListController = marketController(async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), beforeId: marketIdSchema.optional() }).strict().parse(req.query);
  res.json(await listBreadthV2Assessments(query.limit, query.beforeId));
});
export const breadthV2AssessmentDetailController = marketController(async (req, res) => {
  const row = await getBreadthV2Assessment(marketIdSchema.parse(req.params.id));
  if (!row) throw new HttpError(404, 'BREADTH_V2 assessment not found.');
  res.json(row);
});
export const breadthV2AssessmentRunController = marketController(async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  res.json(await publishBreadthV2Assessments());
});

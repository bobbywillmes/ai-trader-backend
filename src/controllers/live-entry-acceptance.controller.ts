import type { NextFunction, Request, Response } from 'express';

import { HttpError } from '../errors/http-error.js';
import {
  abortLiveEntryAcceptanceRun,
  createLiveEntryAcceptanceRun,
  executeLiveEntryAcceptanceRun,
  getCurrentLiveEntryAcceptanceRun,
  getLiveEntryAcceptanceRun,
  listLiveEntryAcceptanceRuns,
  previewLiveEntryAcceptanceRun,
  verifyLiveEntryAcceptanceRun,
} from '../services/live-entry-acceptance.service.js';
import {
  abortLiveEntryAcceptanceRunSchema,
  createLiveEntryAcceptanceRunSchema,
  executeLiveEntryAcceptanceRunSchema,
} from '../validators/live-entry-acceptance.schema.js';

function positiveId(value: unknown, label: string) {
  const id = typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Invalid ${label}.`);
  return id;
}

function actorUserId(res: Response) {
  if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
  return res.locals.user.id;
}

export async function createLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    const input = createLiveEntryAcceptanceRunSchema.parse(req.body);
    res.status(201).json(await createLiveEntryAcceptanceRun({
      tradingAccountId,
      createdByUserId: actorUserId(res),
      ...input,
    }));
  } catch (error) { next(error); }
}

export async function currentLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    res.status(200).json({ run: await getCurrentLiveEntryAcceptanceRun(tradingAccountId) });
  } catch (error) { next(error); }
}

export async function listLiveEntryAcceptanceRunsController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    res.status(200).json({ runs: await listLiveEntryAcceptanceRuns(tradingAccountId) });
  } catch (error) { next(error); }
}

export async function getLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    const runId = positiveId(req.params.runId, 'acceptance run id');
    res.status(200).json(await getLiveEntryAcceptanceRun(tradingAccountId, runId));
  } catch (error) { next(error); }
}

export async function previewLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    const runId = positiveId(req.params.runId, 'acceptance run id');
    res.status(200).json(await previewLiveEntryAcceptanceRun({ tradingAccountId, runId }));
  } catch (error) { next(error); }
}

export async function executeLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    const runId = positiveId(req.params.runId, 'acceptance run id');
    const input = executeLiveEntryAcceptanceRunSchema.parse(req.body);
    res.status(202).json(await executeLiveEntryAcceptanceRun({
      tradingAccountId,
      runId,
      actorUserId: actorUserId(res),
      ...input,
    }));
  } catch (error) { next(error); }
}

export async function verifyLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    const runId = positiveId(req.params.runId, 'acceptance run id');
    res.status(200).json(await verifyLiveEntryAcceptanceRun({ tradingAccountId, runId, actorUserId: actorUserId(res) }));
  } catch (error) { next(error); }
}

export async function abortLiveEntryAcceptanceRunController(req: Request, res: Response, next: NextFunction) {
  try {
    const tradingAccountId = positiveId(req.params.id, 'trading account id');
    const runId = positiveId(req.params.runId, 'acceptance run id');
    const input = abortLiveEntryAcceptanceRunSchema.parse(req.body);
    res.status(200).json(await abortLiveEntryAcceptanceRun({
      tradingAccountId,
      runId,
      actorUserId: actorUserId(res),
      reason: input.reason,
    }));
  } catch (error) { next(error); }
}


import { OperationalAttentionStatus, SystemEventSeverity } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors/http-error.js';
import { acknowledgeOperationalAttention, resolveOperationalAttentionManually } from '../services/operational-attention.service.js';
import { getOperationalAttentionDetail, listOperationalAttention, summarizeOperationalAttention } from '../services/operational-attention-query.service.js';

function user(res: Response) { if (!res.locals.user) throw new HttpError(401, 'Authentication required.'); return res.locals.user; }
function positive(value: unknown, fallback?: number) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed <= 0) throw new HttpError(400, 'A positive integer is required.'); return parsed; }
function account(value: unknown) { if (value === undefined || value === 'all') return null; return positive(value); }
function csvEnum<T extends string>(value: unknown, allowed: readonly T[]) { if (!value || value === 'all') return undefined; const values = String(value).split(',') as T[]; if (values.some((item) => !allowed.includes(item))) throw new HttpError(400, 'Invalid filter value.'); return values; }
export function parseOperationalAttentionStatuses(value: unknown) {
  if (value === 'all') return Object.values(OperationalAttentionStatus);
  return csvEnum(value, Object.values(OperationalAttentionStatus));
}

export async function listOperationalAttentionController(req: Request, res: Response, next: NextFunction) { try {
  const statuses = parseOperationalAttentionStatuses(req.query.status); const severities = csvEnum(req.query.severity, Object.values(SystemEventSeverity)); const source = typeof req.query.source === 'string' && req.query.source !== 'all' ? req.query.source : undefined; const code = typeof req.query.code === 'string' && req.query.code !== 'all' ? req.query.code : undefined;
  res.json(await listOperationalAttention(user(res), { accountId: account(req.query.account), ...(statuses ? { statuses } : {}), ...(severities ? { severities } : {}), ...(source ? { source } : {}), ...(code ? { code } : {}), page: positive(req.query.page, 1), pageSize: Math.min(100, positive(req.query.pageSize, 25)) }));
} catch (error) { next(error); } }
export async function operationalAttentionSummaryController(req: Request, res: Response, next: NextFunction) { try { res.json(await summarizeOperationalAttention(user(res), account(req.query.account))); } catch (error) { next(error); } }
export async function operationalAttentionDetailController(req: Request, res: Response, next: NextFunction) { try { res.json(await getOperationalAttentionDetail(user(res), positive(req.params.id))); } catch (error) { next(error); } }
export async function acknowledgeOperationalAttentionController(req: Request, res: Response, next: NextFunction) { try { const current = await getOperationalAttentionDetail(user(res), positive(req.params.id)); res.json(await acknowledgeOperationalAttention({ id: current.id, actorUserId: user(res).id, expectedRevision: positive(req.body?.expectedRevision) })); } catch (error) { next(error); } }
export async function manualResolveOperationalAttentionController(req: Request, res: Response, next: NextFunction) { try { const current = await getOperationalAttentionDetail(user(res), positive(req.params.id)); res.json(await resolveOperationalAttentionManually({ id: current.id, actorUserId: user(res).id, expectedRevision: positive(req.body?.expectedRevision), reason: typeof req.body?.reason === 'string' ? req.body.reason : '' })); } catch (error) { next(error); } }

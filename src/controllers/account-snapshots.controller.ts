import type { Request, Response, NextFunction } from 'express';
import {
  getAccountSnapshotTrendsForAccounts,
  getLatestAccountSnapshot,
  getAccountSnapshotsForAccounts,
  recordAccountSnapshot,
  type AccountSnapshotQuery,
} from '../services/account-snapshot.service.js';
import type { BrokerMode } from '../types/broker.js';
import { runTradingAccountWorkflow } from '../services/trading-account-workflow-runner.service.js';
import { ACCOUNT_WORKFLOW_LOCK_FAMILIES } from '../services/trading-account-workflow-lock.service.js';
import { HttpError } from '../errors/http-error.js';
import { resolveReportAccountIds } from '../services/report-scope.service.js';

function getAccountScope(value: unknown) {
  if (value === 'all') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) <= 0) {
    throw new HttpError(400, 'account must be all or a positive TradingAccount id.');
  }
  return Number(value);
}

function getQueryNumber(value: unknown, fallback: number) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getQueryString(value: unknown) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function parseQueryDate(value: unknown) {
  const raw = getQueryString(value);

  if (raw === undefined) {
    return { ok: true as const, value: undefined };
  }

  const parsed = new Date(raw);

  if (Number.isNaN(parsed.getTime())) {
    return { ok: false as const };
  }

  return { ok: true as const, value: parsed };
}

function parseMode(value: unknown) {
  const raw = getQueryString(value);

  if (raw === undefined || raw === 'all') {
    return { ok: true as const, value: undefined };
  }

  if (raw === 'paper' || raw === 'live') {
    const mode: BrokerMode = raw;
    return { ok: true as const, value: mode };
  }

  return { ok: false as const };
}

function getAccountSnapshotQuery(
  req: Request,
  res: Response
): AccountSnapshotQuery | null {
  const dateFrom = parseQueryDate(req.query.dateFrom);
  const dateTo = parseQueryDate(req.query.dateTo);
  const mode = parseMode(req.query.mode);

  if (!dateFrom.ok) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid dateFrom query parameter.',
    });
    return null;
  }

  if (!dateTo.ok) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Invalid dateTo query parameter.',
    });
    return null;
  }

  if (!mode.ok) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Unsupported account snapshot mode.',
    });
    return null;
  }

  const query: AccountSnapshotQuery = {};

  if (dateFrom.value !== undefined) query.dateFrom = dateFrom.value;
  if (dateTo.value !== undefined) query.dateTo = dateTo.value;
  if (mode.value !== undefined) query.mode = mode.value;

  return query;
}

export async function getAccountSnapshotsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const query = getAccountSnapshotQuery(req, res);

    if (query === null) {
      return;
    }

    const limit = getQueryNumber(req.query.limit, 50);
    if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
    const accountIds = await resolveReportAccountIds(res.locals.user, getAccountScope(req.query.account));
    const snapshots = await getAccountSnapshotsForAccounts(accountIds, limit, query);

    res.status(200).json({ snapshots });
  } catch (error) {
    next(error);
  }
}

export async function getAccountSnapshotTrendsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const query = getAccountSnapshotQuery(req, res);

    if (query === null) {
      return;
    }

    query.limit = getQueryNumber(req.query.limit, 500);

    if (!res.locals.user) throw new HttpError(401, 'Authentication required.');
    const accountIds = await resolveReportAccountIds(res.locals.user, getAccountScope(req.query.account));
    res.status(200).json(await getAccountSnapshotTrendsForAccounts(accountIds, query));
  } catch (error) {
    next(error);
  }
}

export async function getLatestAccountSnapshotController(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const snapshot = await getLatestAccountSnapshot();

    res.status(200).json({ snapshot });
  } catch (error) {
    next(error);
  }
}

export async function createManualAccountSnapshotController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const tradingAccountId = getAccountScope(req.query.account);
    if (tradingAccountId === null) throw new HttpError(400, 'Manual snapshots require one TradingAccount.');
    const run = await runTradingAccountWorkflow({
      tradingAccountId,
      workerKey: 'account_snapshot_scheduler',
      lockFamily: ACCOUNT_WORKFLOW_LOCK_FAMILIES.ACCOUNT_SNAPSHOT,
      execute: () => recordAccountSnapshot(tradingAccountId, {
        reason: 'manual',
        force: true,
      }),
      classify: (result) => result.skipped
        ? {
            outcome: 'skipped',
            summary: { created: result.created, reason: result.reason },
          }
        : {
            outcome: 'success',
            workSucceeded: result.created,
            summary: { created: result.created, reason: result.reason },
          },
    });
    if (run.outcome === 'FAILED') throw run.error;
    if (run.outcome !== 'PROCESSED') {
      throw new HttpError(
        409,
        run.outcome === 'BACKING_OFF'
          ? `Account snapshot is backing off until ${run.backoffUntil.toISOString()}.`
          : 'Account snapshot is already running.'
      );
    }
    const result = run.value;

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

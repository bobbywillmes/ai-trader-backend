import type { Request, Response, NextFunction } from 'express';
import {
  getAccountSnapshotTrends,
  getLatestAccountSnapshot,
  getRecentAccountSnapshots,
  recordAccountSnapshot,
  type AccountSnapshotQuery,
} from '../services/account-snapshot.service.js';
import type { BrokerMode } from '../types/broker.js';

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
    const snapshots = await getRecentAccountSnapshots(limit, query);

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

    res.status(200).json(await getAccountSnapshotTrends(query));
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
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const result = await recordAccountSnapshot({
      reason: 'manual',
      force: true,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
}

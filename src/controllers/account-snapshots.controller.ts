import type { Request, Response, NextFunction } from 'express';
import {
  getLatestAccountSnapshot,
  getRecentAccountSnapshots,
  recordAccountSnapshot,
} from '../services/account-snapshot.service.js';

function getQueryNumber(value: unknown, fallback: number) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function getAccountSnapshotsController(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const limit = getQueryNumber(req.query.limit, 50);
    const snapshots = await getRecentAccountSnapshots(limit);

    res.status(200).json({ snapshots });
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
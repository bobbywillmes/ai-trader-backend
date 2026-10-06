import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { validDate } from './market-calendar.js';

const LOCK_NAMESPACE = 'ai-trader:market-day-1-logical-session';

/**
 * Stable signed 64-bit key for one Security + logical DAY_1 market session.
 *
 * Both provider timestamp conventions first resolve to the same YYYY-MM-DD session
 * date, so Massive and Tiingo contend on the same transaction-scoped lock. SHA-256
 * is truncated to PostgreSQL's bigint advisory-lock width; a collision is therefore
 * theoretically possible (about 1 in 2^64 for a pair) and would only cause extra
 * serialization, never unsafe concurrent persistence.
 */
export function marketDailySessionLockKey(securityId: number, sessionDate: string): bigint {
  if (!Number.isSafeInteger(securityId) || securityId <= 0) throw new Error('A positive Security id is required for a daily-session lock.');
  if (!validDate(sessionDate)) throw new Error('A valid logical session date is required for a daily-session lock.');
  return createHash('sha256').update(`${LOCK_NAMESPACE}:${securityId}:${sessionDate}`).digest().readBigInt64BE(0);
}

/** Hold until the surrounding PostgreSQL transaction commits or rolls back. */
export async function lockMarketDailySession(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, securityId: number, sessionDate: string) {
  const key = marketDailySessionLockKey(securityId, sessionDate);
  const rows = await tx.$queryRaw<{ acquired: boolean }[]>`SELECT true AS acquired FROM pg_advisory_xact_lock(${key}::bigint)`;
  if (rows[0]?.acquired !== true) throw new Error('Failed to acquire logical daily-session lock.');
}

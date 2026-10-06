import type { TiingoDailyObservationStatus } from '@prisma/client';

export const TIINGO_EMPTY_RETRY_DELAYS_MS = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000] as const;

export function nextTiingoEmptyObservation(previous: { status: TiingoDailyObservationStatus; attemptCount: number } | null, now: Date) {
  if (previous?.status === 'NO_EOD_COVERAGE') return { status: 'NO_EOD_COVERAGE' as const, attemptCount: previous.attemptCount, nextAttemptAt: null };
  const attemptCount = (previous?.attemptCount ?? 0) + 1;
  const delay = TIINGO_EMPTY_RETRY_DELAYS_MS[attemptCount - 1];
  return delay === undefined
    ? { status: 'NO_EOD_COVERAGE' as const, attemptCount, nextAttemptAt: null }
    : { status: 'RETRYING' as const, attemptCount, nextAttemptAt: new Date(now.getTime() + delay) };
}

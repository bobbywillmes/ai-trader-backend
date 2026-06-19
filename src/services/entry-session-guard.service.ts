import type { Prisma } from '@prisma/client';
import { getAlpacaMarketSessionSnapshot } from '../integrations/alpaca/market-session.adapter.js';
import type { NormalizedMarketSessionSnapshot } from '../integrations/alpaca/market-session.adapter.js';
import type { RuntimeTradingConfig } from './config.service.js';

export type EntrySessionBlockRule =
  | 'market_closed'
  | 'entry_open_buffer_active'
  | 'entry_close_buffer_active'
  | 'market_clock_unavailable'
  | 'entry_window_unavailable';

export type EntrySessionStatus =
  | 'disabled'
  | 'allowed'
  | 'market_closed'
  | 'open_buffer'
  | 'close_buffer'
  | 'unavailable'
  | 'degraded'
  | 'invalid_window';

type EntrySessionBaseDetails = {
  enabled: boolean;
  rule?: EntrySessionBlockRule;
  status: EntrySessionStatus;
  currentTimestamp: string;
  evaluatedAt: string;
  sessionOpenAt: string | null;
  sessionCloseAt: string | null;
  entryAllowedAt: string | null;
  entryCutoffAt: string | null;
  openingBufferMinutes: number;
  closingBufferMinutes: number | null;
  marketOpen: boolean | null;
  nextOpenAt: string | null;
  nextCloseAt: string | null;
  failClosed: boolean;
  source?: string;
  tradingDate?: string;
  cache?: NormalizedMarketSessionSnapshot['cache'];
  error?: {
    name: string;
    message: string;
  };
};

export type EntrySessionAllowed = {
  allowed: true;
  degraded: boolean;
  details: EntrySessionBaseDetails;
};

export type EntrySessionBlocked = {
  allowed: false;
  statusCode: number;
  reason: string;
  details: EntrySessionBaseDetails & {
    rule: EntrySessionBlockRule;
  };
};

export type EntrySessionDecision = EntrySessionAllowed | EntrySessionBlocked;

function addMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function subtractMinutes(iso: string, minutes: number) {
  return new Date(new Date(iso).getTime() - minutes * 60_000).toISOString();
}

function toComparableTime(value: string) {
  return new Date(value).getTime();
}

function normalizeError(error: unknown) {
  return {
    name: error instanceof Error ? error.name : 'UnknownError',
    message:
      error instanceof Error
        ? error.message
        : 'Unable to verify Alpaca market session.',
  };
}

function block(
  rule: EntrySessionBlockRule,
  statusCode: number,
  reason: string,
  details: EntrySessionBaseDetails
): EntrySessionBlocked {
  return {
    allowed: false,
    statusCode,
    reason,
    details: {
      ...details,
      rule,
    },
  };
}

export function isEntrySessionBlocked(
  decision: EntrySessionDecision
): decision is EntrySessionBlocked {
  return !decision.allowed;
}

export function entrySessionDetailsAsJson(
  decision: EntrySessionDecision
): Prisma.InputJsonValue {
  return decision.details as unknown as Prisma.InputJsonValue;
}

export async function evaluateEntrySessionGuard(
  config: RuntimeTradingConfig,
  now = new Date()
): Promise<EntrySessionDecision> {
  const currentTimestamp = now.toISOString();

  if (!config.entrySessionGuardEnabled) {
    return {
      allowed: true,
      degraded: false,
      details: {
        enabled: false,
        status: 'disabled',
        currentTimestamp,
        evaluatedAt: currentTimestamp,
        sessionOpenAt: null,
        sessionCloseAt: null,
        entryAllowedAt: null,
        entryCutoffAt: null,
        openingBufferMinutes: config.entryStartMinutesAfterOpen,
        closingBufferMinutes: config.entryCutoffMinutesBeforeClose,
        marketOpen: null,
        nextOpenAt: null,
        nextCloseAt: null,
        failClosed: config.failClosedOnMarketClockError,
      },
    };
  }

  let session: NormalizedMarketSessionSnapshot;

  try {
    session = await getAlpacaMarketSessionSnapshot(now);
  } catch (error) {
    const details: EntrySessionBaseDetails = {
      enabled: true,
      status: config.failClosedOnMarketClockError ? 'unavailable' : 'degraded',
      currentTimestamp,
      evaluatedAt: currentTimestamp,
      sessionOpenAt: null,
      sessionCloseAt: null,
      entryAllowedAt: null,
      entryCutoffAt: null,
      openingBufferMinutes: config.entryStartMinutesAfterOpen,
      closingBufferMinutes: config.entryCutoffMinutesBeforeClose,
      marketOpen: null,
      nextOpenAt: null,
      nextCloseAt: null,
      failClosed: config.failClosedOnMarketClockError,
      error: normalizeError(error),
    };

    if (config.failClosedOnMarketClockError) {
      return block(
        'market_clock_unavailable',
        503,
        'Alpaca market session could not be verified. Entry blocked fail-closed.',
        details
      );
    }

    return {
      allowed: true,
      degraded: true,
      details,
    };
  }

  const evaluatedAt = session.evaluatedTimestamp;
  const baseDetails: EntrySessionBaseDetails = {
    enabled: true,
    status: 'allowed',
    currentTimestamp: evaluatedAt,
    evaluatedAt,
    sessionOpenAt: session.sessionOpenAt,
    sessionCloseAt: session.sessionCloseAt,
    entryAllowedAt: null,
    entryCutoffAt: null,
    openingBufferMinutes: config.entryStartMinutesAfterOpen,
    closingBufferMinutes: config.entryCutoffMinutesBeforeClose,
    marketOpen: session.marketOpen,
    nextOpenAt: session.nextOpenAt,
    nextCloseAt: session.nextCloseAt,
    failClosed: config.failClosedOnMarketClockError,
    source: session.source,
    tradingDate: session.tradingDate,
    cache: session.cache,
  };

  if (!session.marketOpen) {
    return block(
      'market_closed',
      409,
      'Regular market is closed. New entries are blocked.',
      {
        ...baseDetails,
        status: 'market_closed',
      }
    );
  }

  if (!session.sessionOpenAt || !session.sessionCloseAt) {
    return block(
      'entry_window_unavailable',
      409,
      'Regular-session entry window is unavailable. New entries are blocked.',
      {
        ...baseDetails,
        status: 'unavailable',
      }
    );
  }

  const entryAllowedAt = addMinutes(
    session.sessionOpenAt,
    config.entryStartMinutesAfterOpen
  );
  const entryCutoffAt =
    config.entryCutoffMinutesBeforeClose === null
      ? null
      : subtractMinutes(
          session.sessionCloseAt,
          config.entryCutoffMinutesBeforeClose
        );
  const details = {
    ...baseDetails,
    entryAllowedAt,
    entryCutoffAt,
  };

  if (
    entryCutoffAt !== null &&
    toComparableTime(entryAllowedAt) >= toComparableTime(entryCutoffAt)
  ) {
    return block(
      'entry_window_unavailable',
      409,
      'Configured entry buffers leave no valid regular-session entry window.',
      {
        ...details,
        status: 'invalid_window',
      }
    );
  }

  if (toComparableTime(evaluatedAt) < toComparableTime(entryAllowedAt)) {
    return block(
      'entry_open_buffer_active',
      409,
      'Opening entry buffer is still active. New entries are blocked.',
      {
        ...details,
        status: 'open_buffer',
      }
    );
  }

  if (
    entryCutoffAt !== null &&
    toComparableTime(evaluatedAt) >= toComparableTime(entryCutoffAt)
  ) {
    return block(
      'entry_close_buffer_active',
      409,
      'Pre-close entry cutoff is active. New entries are blocked.',
      {
        ...details,
        status: 'close_buffer',
      }
    );
  }

  return {
    allowed: true,
    degraded: false,
    details,
  };
}

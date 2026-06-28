import { alpacaRequest } from './client.js';
import { prisma } from '../../db/prisma.js';
import type {
  AlpacaCalendarSession,
  AlpacaClock,
} from './alpaca.types.js';

const CLOCK_TTL_MS = 45_000;
const CALENDAR_TTL_MS = 12 * 60 * 60 * 1000;
const MARKET_TIME_ZONE = 'America/New_York';
const CLOCK_SETTING_KEY = 'alpacaMarketClockCache';

type CacheStatus = 'fresh' | 'cached';

type ClockCache = {
  raw: AlpacaClock;
  fetchedAtMs: number;
  fetchedAtIso: string;
};

type PersistedClockCache = {
  timestamp: string;
  isOpen: boolean;
  nextOpen: string;
  nextClose: string;
  fetchedAt: string;
};

type CalendarCache = {
  raw: AlpacaCalendarSession | null;
  fetchedAtMs: number;
};

type AlpacaMarketSessionOptions = {
  tradingAccountId?: number;
};

export type NormalizedMarketSessionSnapshot = {
  source: 'alpaca';
  brokerTimestamp: string;
  evaluatedTimestamp: string;
  marketOpen: boolean;
  tradingDate: string;
  sessionOpenAt: string | null;
  sessionCloseAt: string | null;
  nextOpenAt: string | null;
  nextCloseAt: string | null;
  fetchedAt: string;
  cache: {
    clock: CacheStatus;
    calendar: CacheStatus;
  };
};

let clockCache: ClockCache | null = null;
let clockInFlight: Promise<{ raw: AlpacaClock; cacheStatus: CacheStatus }> | null =
  null;

const calendarCache = new Map<string, CalendarCache>();
const calendarInFlight = new Map<
  string,
  Promise<{ raw: AlpacaCalendarSession | null; cacheStatus: CacheStatus }>
>();

function isValidDate(date: Date) {
  return !Number.isNaN(date.getTime());
}

function toIsoOrNull(value: string | undefined | null): string | null {
  if (!value) return null;

  const date = new Date(value);
  return isValidDate(date) ? date.toISOString() : null;
}

function toTimeMs(value: string | null | undefined) {
  if (!value) return null;

  const date = new Date(value);
  return isValidDate(date) ? date.getTime() : null;
}

function serializeClock(raw: AlpacaClock, fetchedAtIso: string): PersistedClockCache | null {
  const timestamp = toIsoOrNull(raw.timestamp);
  const nextOpen = toIsoOrNull(raw.next_open);
  const nextClose = toIsoOrNull(raw.next_close);

  if (!timestamp || !nextOpen || !nextClose) {
    return null;
  }

  return {
    timestamp,
    isOpen: Boolean(raw.is_open),
    nextOpen,
    nextClose,
    fetchedAt: fetchedAtIso,
  };
}

function persistedToClock(cache: PersistedClockCache): ClockCache | null {
  const fetchedAtMs = toTimeMs(cache.fetchedAt);

  if (fetchedAtMs === null) {
    return null;
  }

  return {
    raw: {
      timestamp: cache.timestamp,
      is_open: cache.isOpen,
      next_open: cache.nextOpen,
      next_close: cache.nextClose,
    },
    fetchedAtMs,
    fetchedAtIso: cache.fetchedAt,
  };
}

function parsePersistedClock(value: string | undefined): ClockCache | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<PersistedClockCache>;

    if (
      typeof parsed.timestamp !== 'string' ||
      typeof parsed.isOpen !== 'boolean' ||
      typeof parsed.nextOpen !== 'string' ||
      typeof parsed.nextClose !== 'string' ||
      typeof parsed.fetchedAt !== 'string'
    ) {
      return null;
    }

    return persistedToClock({
      timestamp: parsed.timestamp,
      isOpen: parsed.isOpen,
      nextOpen: parsed.nextOpen,
      nextClose: parsed.nextClose,
      fetchedAt: parsed.fetchedAt,
    });
  } catch {
    return null;
  }
}

function isClockUsable(cache: ClockCache, nowMs: number) {
  const nextCloseMs = toTimeMs(cache.raw.next_close);
  return nextCloseMs !== null && nowMs < nextCloseMs;
}

async function readPersistedClock() {
  const setting = await prisma.setting.findUnique({
    where: { key: CLOCK_SETTING_KEY },
    select: { value: true },
  });

  return parsePersistedClock(setting?.value);
}

async function writePersistedClock(raw: AlpacaClock, fetchedAtIso: string) {
  const serialized = serializeClock(raw, fetchedAtIso);

  if (!serialized) {
    return;
  }

  await prisma.setting.upsert({
    where: { key: CLOCK_SETTING_KEY },
    update: { value: JSON.stringify(serialized) },
    create: { key: CLOCK_SETTING_KEY, value: JSON.stringify(serialized) },
  });
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.get('year')),
    Number(values.get('month')) - 1,
    Number(values.get('day')),
    Number(values.get('hour')),
    Number(values.get('minute')),
    Number(values.get('second'))
  );

  return asUtc - date.getTime();
}

function zonedDateTimeToIso(
  datePart: string,
  timePart: string,
  timeZone: string
) {
  const dateValues = datePart.split('-').map(Number);
  const timeValues = timePart.split(':').map(Number);
  const year = dateValues[0];
  const month = dateValues[1];
  const day = dateValues[2];
  const hour = timeValues[0];
  const minute = timeValues[1];
  const second = timeValues[2] ?? 0;

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second)
  ) {
    return null;
  }

  const y = year as number;
  const m = month as number;
  const d = day as number;
  const h = hour as number;
  const min = minute as number;
  const sec = second as number;
  const utcGuess = new Date(
    Date.UTC(y, m - 1, d, h, min, sec)
  );
  const firstPass = new Date(
    utcGuess.getTime() - getTimeZoneOffsetMs(utcGuess, timeZone)
  );
  const secondPass = new Date(
    utcGuess.getTime() - getTimeZoneOffsetMs(firstPass, timeZone)
  );

  return isValidDate(secondPass) ? secondPass.toISOString() : null;
}

function tradingDateFromIso(iso: string) {
  return iso.slice(0, 10);
}

function advanceTimestamp(rawTimestamp: string, fetchedAtMs: number, nowMs: number) {
  const timestamp = new Date(rawTimestamp);

  if (!isValidDate(timestamp)) {
    throw new Error('Alpaca clock timestamp is invalid.');
  }

  return new Date(timestamp.getTime() + Math.max(0, nowMs - fetchedAtMs));
}

async function getClock(nowMs: number, options: AlpacaMarketSessionOptions = {}) {
  if (clockCache && nowMs - clockCache.fetchedAtMs <= CLOCK_TTL_MS) {
    return { raw: clockCache.raw, cacheStatus: 'cached' as const };
  }

  if (clockCache && isClockUsable(clockCache, nowMs)) {
    return { raw: clockCache.raw, cacheStatus: 'cached' as const };
  }

  const persisted = await readPersistedClock();
  if (persisted && isClockUsable(persisted, nowMs)) {
    clockCache = persisted;
    return { raw: persisted.raw, cacheStatus: 'cached' as const };
  }

  if (!clockInFlight) {
    clockInFlight = alpacaRequest<AlpacaClock>('/v2/clock', {
      tradingAccountId: options.tradingAccountId,
      metadata: {
        operation: 'market_clock',
        endpoint: 'GET /v2/clock',
        method: 'GET',
        requestClass: 'informational_read',
        deferDuringRateLimit: false,
      },
    })
      .then(async (raw) => {
        const fetchedAtIso = new Date().toISOString();
        clockCache = {
          raw,
          fetchedAtMs: Date.now(),
          fetchedAtIso,
        };
        await writePersistedClock(raw, fetchedAtIso);

        return { raw, cacheStatus: 'fresh' as const };
      })
      .finally(() => {
        clockInFlight = null;
      });
  }

  return clockInFlight;
}

async function getCalendarSession(
  tradingDate: string,
  nowMs: number,
  options: AlpacaMarketSessionOptions = {}
) {
  const cached = calendarCache.get(tradingDate);

  if (cached && nowMs - cached.fetchedAtMs <= CALENDAR_TTL_MS) {
    return { raw: cached.raw, cacheStatus: 'cached' as const };
  }

  const existing = calendarInFlight.get(tradingDate);
  if (existing) {
    return existing;
  }

  const request = alpacaRequest<AlpacaCalendarSession[]>(
    `/v2/calendar?start=${encodeURIComponent(tradingDate)}&end=${encodeURIComponent(
      tradingDate
    )}`,
    {
      tradingAccountId: options.tradingAccountId,
      metadata: {
        operation: 'market_calendar',
        endpoint: 'GET /v2/calendar',
        method: 'GET',
        requestClass: 'informational_read',
        deferDuringRateLimit: false,
      },
    }
  )
    .then((raw) => {
      const session = raw[0] ?? null;
      calendarCache.set(tradingDate, {
        raw: session,
        fetchedAtMs: Date.now(),
      });

      return { raw: session, cacheStatus: 'fresh' as const };
    })
    .finally(() => {
      calendarInFlight.delete(tradingDate);
    });

  calendarInFlight.set(tradingDate, request);
  return request;
}

function normalizeCalendarTimestamp(
  tradingDate: string,
  value: string | undefined
) {
  if (!value) return null;

  if (value.includes('T')) {
    return toIsoOrNull(value);
  }

  return zonedDateTimeToIso(tradingDate, value, MARKET_TIME_ZONE);
}

export function clearMarketSessionCache() {
  clockCache = null;
  clockInFlight = null;
  calendarCache.clear();
  calendarInFlight.clear();
}

function deriveMarketOpen(clock: AlpacaClock, evaluatedMs: number) {
  const nextOpenMs = toTimeMs(clock.next_open);
  const nextCloseMs = toTimeMs(clock.next_close);

  if (
    nextOpenMs !== null &&
    nextCloseMs !== null &&
    nextOpenMs <= evaluatedMs &&
    evaluatedMs < nextCloseMs
  ) {
    return true;
  }

  return Boolean(clock.is_open) && nextCloseMs !== null && evaluatedMs < nextCloseMs;
}

function deriveClockSessionWindow(clock: AlpacaClock, evaluatedMs: number) {
  const nextOpenAt = toIsoOrNull(clock.next_open);
  const nextCloseAt = toIsoOrNull(clock.next_close);
  const nextOpenMs = toTimeMs(nextOpenAt);
  const nextCloseMs = toTimeMs(nextCloseAt);

  if (
    nextOpenAt &&
    nextCloseAt &&
    nextOpenMs !== null &&
    nextCloseMs !== null &&
    nextOpenMs <= evaluatedMs &&
    evaluatedMs < nextCloseMs
  ) {
    return {
      sessionOpenAt: nextOpenAt,
      sessionCloseAt: nextCloseAt,
    };
  }

  return {
    sessionOpenAt: null,
    sessionCloseAt: null,
  };
}

export async function getAlpacaMarketSessionSnapshot(
  now = new Date(),
  options: AlpacaMarketSessionOptions = {}
): Promise<NormalizedMarketSessionSnapshot> {
  const nowMs = now.getTime();
  const { raw: clock, cacheStatus: clockStatus } = await getClock(nowMs, options);
  const fetchedAt = clockCache?.fetchedAtIso ?? new Date().toISOString();
  const evaluated = advanceTimestamp(clock.timestamp, clockCache?.fetchedAtMs ?? nowMs, nowMs);
  const evaluatedTimestamp = evaluated.toISOString();
  const evaluatedMs = evaluated.getTime();
  const tradingDate = tradingDateFromIso(evaluatedTimestamp);
  const marketOpen = deriveMarketOpen(clock, evaluatedMs);
  let { sessionOpenAt, sessionCloseAt } = deriveClockSessionWindow(
    clock,
    evaluatedMs
  );
  let calendarStatus: CacheStatus = 'cached';

  if (marketOpen && (!sessionOpenAt || !sessionCloseAt)) {
    const { raw: calendar, cacheStatus } = await getCalendarSession(
      tradingDate,
      nowMs,
      options
    );
    calendarStatus = cacheStatus;

    sessionOpenAt = normalizeCalendarTimestamp(
      tradingDate,
      calendar?.session_open ?? calendar?.open
    );
    sessionCloseAt = normalizeCalendarTimestamp(
      tradingDate,
      calendar?.session_close ?? calendar?.close
    );

    if (calendar && (!sessionOpenAt || !sessionCloseAt)) {
      throw new Error('Alpaca calendar session is missing valid open or close timestamps.');
    }
  }

  return {
    source: 'alpaca',
    brokerTimestamp: clock.timestamp,
    evaluatedTimestamp,
    marketOpen,
    tradingDate,
    sessionOpenAt,
    sessionCloseAt,
    nextOpenAt: toIsoOrNull(clock.next_open),
    nextCloseAt: toIsoOrNull(clock.next_close),
    fetchedAt,
    cache: {
      clock: clockStatus,
      calendar: calendarStatus,
    },
  };
}

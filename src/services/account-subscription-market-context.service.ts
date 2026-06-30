import { PositionSizingType, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import {
  getTickerDailyCandles,
  getTickerLatestPrice,
  type DailyMarketCandle,
  type TickerLatestPrice,
} from './massive-market-data.service.js';

const ACCOUNT_SUBSCRIPTION_MARKET_CONTEXT_SELECT = {
  id: true,
  tradingAccountId: true,
  subscriptionId: true,
  enabled: true,
  sizingType: true,
  fixedQty: true,
  maxPositionNotional: true,
  minPositionNotional: true,
  maxQty: true,
  subscription: {
    select: {
      id: true,
      key: true,
      symbol: true,
    },
  },
} satisfies Prisma.TradingAccountSubscriptionSelect;

type AccountSubscriptionMarketContextRecord =
  Prisma.TradingAccountSubscriptionGetPayload<{
    select: typeof ACCOUNT_SUBSCRIPTION_MARKET_CONTEXT_SELECT;
  }>;

export type AccountSubscriptionMarketContextStatus =
  | 'active'
  | 'all'
  | 'disabled';

export type AccountSubscriptionPriceHistoryRange = '3m' | '6m' | '1y';

export type AccountSubscriptionMarketContextItem = {
  accountSubscriptionId: number;
  subscriptionId: number;
  symbol: string;
  subscriptionKey: string;
  latestPrice: number | null;
  latestPriceAt: string | null;
  latestPriceSource: string | null;
  week52High: number | null;
  week52Low: number | null;
  week52HighAt: string | null;
  week52LowAt: string | null;
  sizingType: PositionSizingType;
  fixedQty: number | null;
  maxPositionNotional: number | null;
  minPositionNotional: number | null;
  maxQty: number | null;
  estimatedQty: number | null;
  estimatedNotional: number | null;
  nextShareQty: number | null;
  nextShareNotional: number | null;
  dollarsToNextShare: number | null;
  warnings: string[];
};

export type AccountSubscriptionMarketContextResponse = {
  tradingAccountId: number;
  generatedAt: string;
  items: AccountSubscriptionMarketContextItem[];
};

export type AccountSubscriptionPriceHistoryResponse = {
  tradingAccountId: number;
  accountSubscriptionId: number;
  subscriptionId: number;
  symbol: string;
  range: AccountSubscriptionPriceHistoryRange;
  generatedAt: string;
  candles: DailyMarketCandle[];
  summary: {
    latestClose: number | null;
    latestCloseAt: string | null;
    week52High: number | null;
    week52Low: number | null;
  };
};

type SymbolMarketContext = {
  latest: TickerLatestPrice | null;
  candles: DailyMarketCandle[];
  warnings: string[];
};

type ListMarketContextOptions = {
  status?: AccountSubscriptionMarketContextStatus;
  symbols?: string[];
  now?: Date;
};

type PriceHistoryOptions = {
  range?: AccountSubscriptionPriceHistoryRange;
  now?: Date;
};

export function parseAccountSubscriptionMarketContextStatus(
  value: unknown
): AccountSubscriptionMarketContextStatus {
  return value === 'all' || value === 'disabled' ? value : 'active';
}

export function parseAccountSubscriptionPriceHistoryRange(
  value: unknown
): AccountSubscriptionPriceHistoryRange {
  return value === '3m' || value === '6m' ? value : '1y';
}

function normalizeSymbol(value: string) {
  return value.trim().toUpperCase();
}

function getEtDateString(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  return year && month && day ? `${year}-${month}-${day}` : null;
}

function subtractRange(
  date: Date,
  range: AccountSubscriptionPriceHistoryRange
) {
  const result = new Date(date);

  if (range === '3m') {
    result.setUTCMonth(result.getUTCMonth() - 3);
  } else if (range === '6m') {
    result.setUTCMonth(result.getUTCMonth() - 6);
  } else {
    result.setUTCFullYear(result.getUTCFullYear() - 1);
  }

  return result;
}

function getDateBounds(
  now: Date,
  range: AccountSubscriptionPriceHistoryRange
) {
  const from = getEtDateString(subtractRange(now, range));
  const to = getEtDateString(now);

  if (!from || !to) {
    throw new Error('Unable to resolve market-data date range.');
  }

  return { from, to };
}

function summarizeWeek52(candles: DailyMarketCandle[]) {
  const high = candles.reduce<
    { value: number; date: string } | null
  >((current, candle) => {
    if (!current || candle.high > current.value) {
      return { value: candle.high, date: candle.date };
    }

    return current;
  }, null);
  const low = candles.reduce<
    { value: number; date: string } | null
  >((current, candle) => {
    if (!current || candle.low < current.value) {
      return { value: candle.low, date: candle.date };
    }

    return current;
  }, null);

  return {
    week52High: high?.value ?? null,
    week52HighAt: high?.date ?? null,
    week52Low: low?.value ?? null,
    week52LowAt: low?.date ?? null,
  };
}

function calculateBudgetPreview(
  accountSubscription: AccountSubscriptionMarketContextRecord,
  latestPrice: number | null,
  warnings: string[]
) {
  if (latestPrice === null || latestPrice <= 0) {
    warnings.push('Latest price unavailable.');

    return {
      estimatedQty: null,
      estimatedNotional: null,
      nextShareQty: null,
      nextShareNotional: null,
      dollarsToNextShare: null,
    };
  }

  if (accountSubscription.sizingType === PositionSizingType.FIXED_QTY) {
    const fixedQty = accountSubscription.fixedQty;

    return {
      estimatedQty: fixedQty,
      estimatedNotional: fixedQty === null ? null : fixedQty * latestPrice,
      nextShareQty: null,
      nextShareNotional: null,
      dollarsToNextShare: null,
    };
  }

  const maxPositionNotional = accountSubscription.maxPositionNotional;

  if (maxPositionNotional === null || maxPositionNotional <= 0) {
    return {
      estimatedQty: null,
      estimatedNotional: null,
      nextShareQty: null,
      nextShareNotional: null,
      dollarsToNextShare: null,
    };
  }

  const estimatedQty = Math.floor(maxPositionNotional / latestPrice);
  const estimatedNotional = estimatedQty * latestPrice;
  const nextShareQty = estimatedQty + 1;
  const nextShareNotional = nextShareQty * latestPrice;

  if (estimatedQty < 1) {
    warnings.push(
      'Budget is below the latest price; calculated quantity would be 0.'
    );
  }

  return {
    estimatedQty,
    estimatedNotional,
    nextShareQty,
    nextShareNotional,
    dollarsToNextShare: Math.max(
      0,
      nextShareNotional - maxPositionNotional
    ),
  };
}

async function tradingAccountExists(tradingAccountId: number) {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: tradingAccountId },
    select: { id: true },
  });

  return account !== null;
}

async function getSymbolMarketContext(
  symbol: string,
  now: Date
): Promise<SymbolMarketContext> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const { from, to } = getDateBounds(now, '1y');
  const warnings: string[] = [];
  const [latestResult, candlesResult] = await Promise.allSettled([
    getTickerLatestPrice(normalizedSymbol),
    getTickerDailyCandles(normalizedSymbol, from, to),
  ]);
  const latest =
    latestResult.status === 'fulfilled' ? latestResult.value : null;
  const candles =
    candlesResult.status === 'fulfilled' ? candlesResult.value : [];

  if (latestResult.status === 'rejected') {
    warnings.push('Latest price unavailable.');
  }

  if (candlesResult.status === 'rejected') {
    warnings.push('52-week price history unavailable.');
  }

  return { latest, candles, warnings };
}

function toMarketContextItem(
  accountSubscription: AccountSubscriptionMarketContextRecord,
  symbolContext: SymbolMarketContext
): AccountSubscriptionMarketContextItem {
  const warnings = [...symbolContext.warnings];
  const latestPrice = symbolContext.latest?.latestPrice ?? null;
  const week52 = summarizeWeek52(symbolContext.candles);
  const preview = calculateBudgetPreview(
    accountSubscription,
    latestPrice,
    warnings
  );

  return {
    accountSubscriptionId: accountSubscription.id,
    subscriptionId: accountSubscription.subscriptionId,
    symbol: accountSubscription.subscription.symbol,
    subscriptionKey: accountSubscription.subscription.key,
    latestPrice,
    latestPriceAt: symbolContext.latest?.latestPriceAt ?? null,
    latestPriceSource: symbolContext.latest?.latestPriceSource ?? null,
    ...week52,
    sizingType: accountSubscription.sizingType,
    fixedQty: accountSubscription.fixedQty,
    maxPositionNotional: accountSubscription.maxPositionNotional,
    minPositionNotional: accountSubscription.minPositionNotional,
    maxQty: accountSubscription.maxQty,
    ...preview,
    warnings: Array.from(new Set(warnings)),
  };
}

export async function listAccountSubscriptionMarketContextForAdmin(
  tradingAccountId: number,
  options: ListMarketContextOptions = {}
): Promise<AccountSubscriptionMarketContextResponse | null> {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const accountSubscriptions = await prisma.tradingAccountSubscription.findMany({
    where: {
      tradingAccountId,
      ...(options.status === 'active' || options.status === undefined
        ? { enabled: true }
        : {}),
      ...(options.status === 'disabled' ? { enabled: false } : {}),
    },
    select: ACCOUNT_SUBSCRIPTION_MARKET_CONTEXT_SELECT,
    orderBy: [{ enabled: 'desc' }, { id: 'asc' }],
  });
  const symbolFilter = new Set((options.symbols ?? []).map(normalizeSymbol));
  const filteredAccountSubscriptions =
    symbolFilter.size === 0
      ? accountSubscriptions
      : accountSubscriptions.filter((accountSubscription) =>
          symbolFilter.has(normalizeSymbol(accountSubscription.subscription.symbol))
        );
  const now = options.now ?? new Date();
  const contextsBySymbol = new Map<string, Promise<SymbolMarketContext>>();

  for (const accountSubscription of filteredAccountSubscriptions) {
    const symbol = normalizeSymbol(accountSubscription.subscription.symbol);

    if (!contextsBySymbol.has(symbol)) {
      contextsBySymbol.set(symbol, getSymbolMarketContext(symbol, now));
    }
  }

  const items = await Promise.all(
    filteredAccountSubscriptions.map(async (accountSubscription) => {
      const symbol = normalizeSymbol(accountSubscription.subscription.symbol);
      const contextPromise = contextsBySymbol.get(symbol);

      if (!contextPromise) {
        throw new Error(`Missing market context fetch for ${symbol}.`);
      }

      const symbolContext = await contextPromise;

      return toMarketContextItem(accountSubscription, symbolContext);
    })
  );

  return {
    tradingAccountId,
    generatedAt: now.toISOString(),
    items,
  };
}

export async function getAccountSubscriptionPriceHistoryForAdmin(
  tradingAccountId: number,
  accountSubscriptionId: number,
  options: PriceHistoryOptions = {}
): Promise<AccountSubscriptionPriceHistoryResponse | null> {
  if (!(await tradingAccountExists(tradingAccountId))) {
    return null;
  }

  const accountSubscription =
    await prisma.tradingAccountSubscription.findFirst({
      where: {
        id: accountSubscriptionId,
        tradingAccountId,
      },
      select: ACCOUNT_SUBSCRIPTION_MARKET_CONTEXT_SELECT,
    });

  if (!accountSubscription) {
    return null;
  }

  const range = options.range ?? '1y';
  const now = options.now ?? new Date();
  const { from, to } = getDateBounds(now, range);
  const candles = await getTickerDailyCandles(
    accountSubscription.subscription.symbol,
    from,
    to
  );
  const latest = candles.at(-1);
  const week52Bounds = getDateBounds(now, '1y');
  const week52Candles =
    range === '1y'
      ? candles
      : await getTickerDailyCandles(
          accountSubscription.subscription.symbol,
          week52Bounds.from,
          week52Bounds.to
        );
  const week52 = summarizeWeek52(week52Candles);

  return {
    tradingAccountId,
    accountSubscriptionId: accountSubscription.id,
    subscriptionId: accountSubscription.subscriptionId,
    symbol: accountSubscription.subscription.symbol,
    range,
    generatedAt: now.toISOString(),
    candles,
    summary: {
      latestClose: latest?.close ?? null,
      latestCloseAt: latest?.date ?? null,
      week52High: week52.week52High,
      week52Low: week52.week52Low,
    },
  };
}

import { listTradeCycles, type TradeCycleFilters } from './trade-cycles.service.js';

export type TradePerformanceOutcome = 'all' | 'winner' | 'loser' | 'breakeven';
export type TradePerformanceSortBy =
  | 'closedAt'
  | 'openedAt'
  | 'symbol'
  | 'realizedPnl'
  | 'returnPct'
  | 'holdingDurationMs';
export type TradePerformanceSortDirection = 'asc' | 'desc';

export type TradePerformanceQuery = {
  dateFrom?: Date;
  dateTo?: Date;
  symbol?: string;
  strategyId?: number;
  subscriptionId?: number;
  exitProfileId?: number;
  exitReason?: string;
  outcome?: TradePerformanceOutcome;
  mode?: string;
  limit?: number;
  page?: number;
  pageSize?: number;
  sortBy?: TradePerformanceSortBy;
  sortDirection?: TradePerformanceSortDirection;
};

type PerformanceCycle = {
  id: number;
  symbol: string;
  side: string;
  openedAt: Date | string;
  closedAt: Date | string | null;
  quantity: number;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  holdingDurationMs: number | null;
  strategy: { id: number | null; key: string | null; name: string | null } | null;
  subscription: {
    id: number | null;
    key: string | null;
    name: string | null;
    brokerMode?: string | null;
  } | null;
  exitProfile: { id: number | null; key: string | null; name: string | null } | null;
  exitReason: string | null;
};

export type TradePerformanceTradeRow = {
  id: number;
  symbol: string;
  side: string;
  mode: string | null;
  openedAt: string;
  closedAt: string | null;
  quantity: number;
  avgEntryPrice: number | null;
  avgExitPrice: number | null;
  realizedPnl: number | null;
  returnPct: number | null;
  holdingDurationMs: number | null;
  strategy: PerformanceCycle['strategy'];
  subscription: PerformanceCycle['subscription'];
  exitProfile: PerformanceCycle['exitProfile'];
  exitReason: string | null;
};

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function isReportable(cycle: PerformanceCycle) {
  return cycle.realizedPnl !== null && cycle.returnPct !== null;
}

function toDate(value: Date | string | null) {
  if (value === null) return null;

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizePositiveInt(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function normalizePageSize(query: TradePerformanceQuery) {
  const requested = normalizePositiveInt(
    query.pageSize ?? query.limit,
    DEFAULT_PAGE_SIZE
  );

  return Math.min(requested, MAX_PAGE_SIZE);
}

function normalizeSymbol(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toUpperCase() : undefined;
}

function normalizeString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function matchesOutcome(
  cycle: PerformanceCycle,
  outcome: TradePerformanceOutcome | undefined
) {
  if (outcome === undefined || outcome === 'all') {
    return true;
  }

  if (cycle.realizedPnl === null) {
    return false;
  }

  if (outcome === 'winner') return cycle.realizedPnl > 0;
  if (outcome === 'loser') return cycle.realizedPnl < 0;

  return cycle.realizedPnl === 0;
}

function filterCycles(
  cycles: PerformanceCycle[],
  query: TradePerformanceQuery
) {
  const exitReason = normalizeString(query.exitReason);

  return cycles.filter((cycle) => {
    if (exitReason && cycle.exitReason !== exitReason) {
      return false;
    }

    return matchesOutcome(cycle, query.outcome);
  });
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function profitFactor(cycles: PerformanceCycle[]) {
  const grossProfit = cycles
    .filter((cycle) => (cycle.realizedPnl ?? 0) > 0)
    .reduce((sum, cycle) => sum + (cycle.realizedPnl ?? 0), 0);
  const grossLoss = Math.abs(
    cycles
      .filter((cycle) => (cycle.realizedPnl ?? 0) < 0)
      .reduce((sum, cycle) => sum + (cycle.realizedPnl ?? 0), 0)
  );

  if (grossLoss === 0) {
    return grossProfit > 0 ? null : 0;
  }

  return grossProfit / grossLoss;
}

function summarizeCycles(cycles: PerformanceCycle[]) {
  const reportable = cycles.filter(isReportable);
  const winners = reportable.filter((cycle) => (cycle.realizedPnl ?? 0) > 0);
  const losers = reportable.filter((cycle) => (cycle.realizedPnl ?? 0) < 0);
  const totalRealizedPnl = reportable.reduce(
    (sum, cycle) => sum + (cycle.realizedPnl ?? 0),
    0
  );
  const returnValues = reportable
    .map((cycle) => cycle.returnPct)
    .filter((value): value is number => value !== null);
  const holdingDurations = reportable
    .map((cycle) => cycle.holdingDurationMs)
    .filter((value): value is number => value !== null);

  return {
    tradeCount: cycles.length,
    reportableTradeCount: reportable.length,
    totalRealizedPnl,
    averageReturnPct: average(returnValues),
    winRate: reportable.length > 0 ? winners.length / reportable.length : null,
    winnerCount: winners.length,
    loserCount: losers.length,
    averageWinner: average(winners.map((cycle) => cycle.realizedPnl ?? 0)),
    averageLoser: average(losers.map((cycle) => cycle.realizedPnl ?? 0)),
    profitFactor: profitFactor(reportable),
    averageHoldingDurationMs: average(holdingDurations),
  };
}

function groupBy(
  cycles: PerformanceCycle[],
  getGroup: (cycle: PerformanceCycle) => {
    id: string;
    label: string;
  }
) {
  const groups = new Map<string, { id: string; label: string; cycles: PerformanceCycle[] }>();

  for (const cycle of cycles) {
    const group = getGroup(cycle);
    const existing = groups.get(group.id) ?? {
      id: group.id,
      label: group.label,
      cycles: [],
    };

    existing.cycles.push(cycle);
    groups.set(group.id, existing);
  }

  return Array.from(groups.values())
    .map((group) => ({
      id: group.id,
      label: group.label,
      ...summarizeCycles(group.cycles),
    }))
    .sort((a, b) => b.totalRealizedPnl - a.totalRealizedPnl);
}

function buildTradeCycleFilters(
  query: TradePerformanceQuery
): TradeCycleFilters {
  const filters: TradeCycleFilters = {
    status: 'closed',
    limit: null,
  };
  const symbol = normalizeSymbol(query.symbol);

  if (symbol !== undefined) filters.symbol = symbol;
  if (query.dateFrom !== undefined) filters.closedDateFrom = query.dateFrom;
  if (query.dateTo !== undefined) filters.closedDateTo = query.dateTo;
  if (query.strategyId !== undefined) filters.strategyId = query.strategyId;
  if (query.subscriptionId !== undefined) {
    filters.subscriptionId = query.subscriptionId;
  }
  if (query.exitProfileId !== undefined) {
    filters.exitProfileId = query.exitProfileId;
  }
  if (query.mode !== undefined) filters.mode = query.mode;

  return filters;
}

function getSortValue(
  cycle: PerformanceCycle,
  sortBy: TradePerformanceSortBy
): string | number | null {
  if (sortBy === 'symbol') return cycle.symbol;
  if (sortBy === 'openedAt') return toDate(cycle.openedAt)?.getTime() ?? null;
  if (sortBy === 'closedAt') return toDate(cycle.closedAt)?.getTime() ?? null;
  if (sortBy === 'realizedPnl') return cycle.realizedPnl;
  if (sortBy === 'returnPct') return cycle.returnPct;

  return cycle.holdingDurationMs;
}

function compareNullableValues(
  left: string | number | null,
  right: string | number | null
) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  if (typeof left === 'string' && typeof right === 'string') {
    return left.localeCompare(right);
  }

  return Number(left) - Number(right);
}

function sortCycles(
  cycles: PerformanceCycle[],
  query: TradePerformanceQuery
) {
  const sortBy = query.sortBy ?? 'closedAt';
  const sortDirection = query.sortDirection ?? 'desc';

  return [...cycles].sort((left, right) => {
    const primary = compareNullableValues(
      getSortValue(left, sortBy),
      getSortValue(right, sortBy)
    );
    const directed = sortDirection === 'asc' ? primary : -primary;

    if (directed !== 0) {
      return directed;
    }

    return right.id - left.id;
  });
}

function toTradeRow(cycle: PerformanceCycle): TradePerformanceTradeRow {
  return {
    id: cycle.id,
    symbol: cycle.symbol,
    side: cycle.side,
    mode: cycle.subscription?.brokerMode ?? null,
    openedAt: toDate(cycle.openedAt)?.toISOString() ?? String(cycle.openedAt),
    closedAt: toDate(cycle.closedAt)?.toISOString() ?? null,
    quantity: cycle.quantity,
    avgEntryPrice: cycle.avgEntryPrice,
    avgExitPrice: cycle.avgExitPrice,
    realizedPnl: cycle.realizedPnl,
    returnPct: cycle.returnPct,
    holdingDurationMs: cycle.holdingDurationMs,
    strategy: cycle.strategy,
    subscription: cycle.subscription,
    exitProfile: cycle.exitProfile,
    exitReason: cycle.exitReason,
  };
}

export async function getTradePerformance(query: TradePerformanceQuery = {}) {
  const page = normalizePositiveInt(query.page, DEFAULT_PAGE);
  const pageSize = normalizePageSize(query);
  const sortBy = query.sortBy ?? 'closedAt';
  const sortDirection = query.sortDirection ?? 'desc';
  const result = await listTradeCycles(buildTradeCycleFilters(query));
  const cycles = filterCycles(result.cycles as PerformanceCycle[], query);
  const reportable = cycles.filter(isReportable);
  const sortedCycles = sortCycles(cycles, {
    ...query,
    sortBy,
    sortDirection,
  });
  const total = sortedCycles.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const skip = (page - 1) * pageSize;
  const trades = sortedCycles.slice(skip, skip + pageSize).map(toTradeRow);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      dateFrom: query.dateFrom?.toISOString() ?? null,
      dateTo: query.dateTo?.toISOString() ?? null,
      symbol: normalizeSymbol(query.symbol) ?? null,
      strategyId: query.strategyId ?? null,
      subscriptionId: query.subscriptionId ?? null,
      exitProfileId: query.exitProfileId ?? null,
      exitReason: normalizeString(query.exitReason) ?? null,
      outcome: query.outcome ?? 'all',
      mode: query.mode ?? null,
      limit: query.limit ?? null,
      page,
      pageSize,
      sortBy,
      sortDirection,
    },
    summary: summarizeCycles(cycles),
    groups: {
      byStrategy: groupBy(reportable, (cycle) => ({
        id: cycle.strategy?.key ?? 'unknown',
        label: cycle.strategy?.name ?? 'Unknown Strategy',
      })),
      bySubscription: groupBy(reportable, (cycle) => ({
        id: cycle.subscription?.key ?? 'unknown',
        label: cycle.subscription?.name ?? 'Unknown Subscription',
      })),
      byExitProfile: groupBy(reportable, (cycle) => ({
        id: cycle.exitProfile?.key ?? 'unknown',
        label: cycle.exitProfile?.name ?? 'Unknown Exit Profile',
      })),
      bySecurity: groupBy(reportable, (cycle) => ({
        id: cycle.symbol,
        label: cycle.symbol,
      })),
      byExitReason: groupBy(reportable, (cycle) => ({
        id: cycle.exitReason ?? 'unknown',
        label: cycle.exitReason ?? 'Unknown',
      })),
    },
    trades,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && total > 0,
    },
  };
}

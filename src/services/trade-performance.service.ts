import { listTradeCycles, type TradeCycleFilters } from './trade-cycles.service.js';

export type TradePerformanceQuery = {
  dateFrom?: Date;
  dateTo?: Date;
  strategyId?: number;
  subscriptionId?: number;
  exitProfileId?: number;
  mode?: string;
  limit?: number;
};

type PerformanceCycle = {
  id: number;
  symbol: string;
  closedAt: Date | string | null;
  realizedPnl: number | null;
  returnPct: number | null;
  holdingDurationMs: number | null;
  strategy: { id: number | null; key: string | null; name: string | null } | null;
  subscription: { id: number | null; key: string | null; name: string | null } | null;
  exitProfile: { id: number | null; key: string | null; name: string | null } | null;
  exitReason: string | null;
};

function isReportable(cycle: PerformanceCycle) {
  return cycle.realizedPnl !== null && cycle.returnPct !== null;
}

function getCycleClosedAt(cycle: PerformanceCycle) {
  if (cycle.closedAt === null) return null;

  const closedAt =
    cycle.closedAt instanceof Date ? cycle.closedAt : new Date(cycle.closedAt);

  return Number.isNaN(closedAt.getTime()) ? null : closedAt;
}

function filterByClosedAt(
  cycles: PerformanceCycle[],
  query: TradePerformanceQuery
) {
  if (query.dateFrom === undefined && query.dateTo === undefined) {
    return cycles;
  }

  return cycles.filter((cycle) => {
    const closedAt = getCycleClosedAt(cycle);

    if (closedAt === null) return false;
    if (query.dateFrom !== undefined && closedAt < query.dateFrom) return false;
    if (query.dateTo !== undefined && closedAt > query.dateTo) return false;

    return true;
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
    limit: query.limit ?? 1000,
  };

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

export async function getTradePerformance(query: TradePerformanceQuery = {}) {
  const result = await listTradeCycles(buildTradeCycleFilters(query));
  const cycles = filterByClosedAt(result.cycles as PerformanceCycle[], query);
  const reportable = cycles.filter(isReportable);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      dateFrom: query.dateFrom?.toISOString() ?? null,
      dateTo: query.dateTo?.toISOString() ?? null,
      strategyId: query.strategyId ?? null,
      subscriptionId: query.subscriptionId ?? null,
      exitProfileId: query.exitProfileId ?? null,
      mode: query.mode ?? null,
      limit: query.limit ?? 1000,
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
  };
}

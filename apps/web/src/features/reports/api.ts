import { apiRequest } from "../../lib/api";
import type {
  AccountSnapshotQuery,
  AccountSnapshotsResponse,
  AccountSnapshotTrendsResponse,
  BrokerActivitiesQuery,
  BrokerActivitiesResponse,
  BrokerActivitySyncResponse,
  TradePerformanceQuery,
  TradePerformanceResponse,
  ManualAccountSnapshotResponse,
} from "./types";

function buildQuery(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }

  const query = search.toString();

  return query ? `?${query}` : "";
}

export function getAccountSnapshots(
  token: string,
  query: AccountSnapshotQuery = {},
) {
  return apiRequest<AccountSnapshotsResponse>(
    `/api/account-snapshots${buildQuery({
      account: query.account,
      limit: query.limit,
      mode: query.mode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    })}`,
    { token },
  );
}

export function getAccountSnapshotTrends(
  token: string,
  query: AccountSnapshotQuery = {},
) {
  return apiRequest<AccountSnapshotTrendsResponse>(
    `/api/account-snapshots/trends${buildQuery({
      account: query.account,
      limit: query.limit,
      mode: query.mode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    })}`,
    { token },
  );
}

export function createManualAccountSnapshot(token: string, account: string) {
  return apiRequest<ManualAccountSnapshotResponse>(
    `/api/account-snapshots/manual${buildQuery({ account })}`,
    {
      method: "POST",
      token,
    },
  );
}

export function getBrokerActivities(
  token: string,
  query: BrokerActivitiesQuery = {},
) {
  return apiRequest<BrokerActivitiesResponse>(
    `/api/broker-activities${buildQuery({
      account: query.account,
      limit: query.limit,
      symbol: query.symbol,
      activityType: query.activityType,
    })}`,
    { token },
  );
}

export function syncBrokerActivities(token: string, account: string) {
  return apiRequest<BrokerActivitySyncResponse>(
    `/api/broker-activities/sync${buildQuery({ account })}`,
    {
      method: "POST",
      token,
    },
  );
}

export function getTradePerformance(
  token: string,
  query: TradePerformanceQuery = {},
) {
  return apiRequest<TradePerformanceResponse>(
    `/api/trade-performance${buildQuery({
      account: query.account,
      mode: query.mode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      symbol: query.symbol,
      strategyId: query.strategyId,
      subscriptionId: query.subscriptionId,
      exitProfileId: query.exitProfileId,
      exitReason: query.exitReason,
      outcome: query.outcome,
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
    })}`,
    { token },
  );
}

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
  query: AccountSnapshotQuery = {}
) {
  return apiRequest<AccountSnapshotsResponse>(
    `/api/account-snapshots${buildQuery({
      limit: query.limit,
      mode: query.mode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    })}`,
    { token }
  );
}

export function getAccountSnapshotTrends(
  token: string,
  query: AccountSnapshotQuery = {}
) {
  return apiRequest<AccountSnapshotTrendsResponse>(
    `/api/account-snapshots/trends${buildQuery({
      limit: query.limit,
      mode: query.mode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    })}`,
    { token }
  );
}

export function createManualAccountSnapshot(token: string) {
  return apiRequest<ManualAccountSnapshotResponse>(
    "/api/account-snapshots/manual",
    {
      method: "POST",
      token,
    }
  );
}

export function getBrokerActivities(
  token: string,
  query: BrokerActivitiesQuery = {}
) {
  return apiRequest<BrokerActivitiesResponse>(
    `/api/broker-activities${buildQuery({
      limit: query.limit,
      symbol: query.symbol,
      activityType: query.activityType,
    })}`,
    { token }
  );
}

export function syncBrokerActivities(token: string) {
  return apiRequest<BrokerActivitySyncResponse>("/api/broker-activities/sync", {
    method: "POST",
    token,
  });
}

export function getTradePerformance(
  token: string,
  query: TradePerformanceQuery = {}
) {
  return apiRequest<TradePerformanceResponse>(
    `/api/trade-performance${buildQuery({
      limit: query.limit,
      mode: query.mode,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      strategyId: query.strategyId,
      subscriptionId: query.subscriptionId,
      exitProfileId: query.exitProfileId,
    })}`,
    { token }
  );
}

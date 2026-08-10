import { apiRequest } from "../../lib/api";
import type {
  BootstrapResponse,
  IndexChartRange,
  IndexIntradayResponse,
  IndexPerformanceResponse,
  SystemEventsResponse,
  TradingAccountDashboardResponse,
  DashboardAccountsOverviewResponse,
} from "./types";

export function getBootstrap(token: string) {
  return apiRequest<BootstrapResponse>("/api/bootstrap", { token });
}

export function getTradingAccountDashboard(
  token: string,
  tradingAccountId: number,
) {
  return apiRequest<TradingAccountDashboardResponse>(
    `/api/trading-accounts/${tradingAccountId}/dashboard`,
    { token },
  );
}

export function getDashboardAccountsOverview(token: string) {
  return apiRequest<DashboardAccountsOverviewResponse>(
    "/api/dashboard/accounts-overview",
    { token },
  );
}

export function getSystemEvents(
  token: string,
  account: "all" | number,
  page = 1,
  pageSize = 25,
  type?: string,
  search?: string,
) {
  const query = new URLSearchParams({
    account: String(account),
    page: String(page),
    pageSize: String(pageSize),
  });
  if (type && type !== "all") query.set("type", type);
  if (search?.trim()) query.set("search", search.trim());
  return apiRequest<SystemEventsResponse>(
    `/api/system-events?${query.toString()}`,
    { token },
  );
}

export function getIndexPerformance(token: string) {
  return apiRequest<IndexPerformanceResponse>(
    "/api/dashboard/index-performance",
    { token },
  );
}

export function getIndexIntraday(token: string, range: IndexChartRange) {
  const query = new URLSearchParams({ range });

  return apiRequest<IndexIntradayResponse>(
    `/api/dashboard/index-intraday?${query.toString()}`,
    { token },
  );
}

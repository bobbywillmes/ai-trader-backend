import { useQuery } from "@tanstack/react-query";
import {
  getIndexIntraday,
  getIndexPerformance,
  getSystemEvents,
  getTradingAccountDashboard,
  getDashboardAccountsOverview,
} from "./api";
import type { IndexChartRange } from "./types";

export const dashboardKeys = {
  indexIntraday: (range: IndexChartRange) =>
    ["dashboard", "index-intraday", range] as const,
  indexPerformance: ["dashboard", "index-performance"] as const,
  systemEvents: (
    account: "all" | number,
    page: number,
    pageSize: number,
    type: string,
    search: string,
  ) => ["system-events", account, page, pageSize, type, search] as const,
  account: (tradingAccountId: number) =>
    ["dashboard", "account", tradingAccountId] as const,
  accountsOverview: ["dashboard", "scope", "all", "accounts-overview"] as const,
};

export function useTradingAccountDashboard(
  token: string | null,
  tradingAccountId: number | null,
) {
  return useQuery({
    queryKey: dashboardKeys.account(tradingAccountId ?? 0),
    queryFn: () =>
      getTradingAccountDashboard(token as string, tradingAccountId as number),
    enabled: Boolean(token && tradingAccountId),
    refetchInterval: 10000,
    staleTime: 5000,
  });
}

export function useDashboardAccountsOverview(
  token: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: dashboardKeys.accountsOverview,
    queryFn: () => getDashboardAccountsOverview(token as string),
    enabled: Boolean(token && enabled),
    refetchInterval: 15000,
    staleTime: 10000,
  });
}

export function useSystemEvents(
  token: string | null,
  account: "all" | number,
  page = 1,
  pageSize = 25,
  type = "all",
  search = "",
) {
  return useQuery({
    queryKey: dashboardKeys.systemEvents(account, page, pageSize, type, search),
    queryFn: () =>
      getSystemEvents(token as string, account, page, pageSize, type, search),
    enabled: Boolean(token),
    refetchInterval: 15000,
  });
}

export function useIndexPerformance(token: string | null) {
  return useQuery({
    queryKey: dashboardKeys.indexPerformance,
    queryFn: () => getIndexPerformance(token as string),
    enabled: Boolean(token),
    refetchInterval: 10000,
    staleTime: 0,
  });
}

export function useIndexIntraday(token: string | null, range: IndexChartRange) {
  return useQuery({
    queryKey: dashboardKeys.indexIntraday(range),
    queryFn: () => getIndexIntraday(token as string, range),
    enabled: Boolean(token),
    refetchInterval: 60000,
    staleTime: 30000,
  });
}

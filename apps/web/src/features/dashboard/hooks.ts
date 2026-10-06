import { useQuery } from "@tanstack/react-query";
import {
  getDashboardReferencePrices,
  getDashboardMarketState,
  getSystemEvents,
  getTradingAccountDashboard,
  getDashboardAccountsOverview,
} from "./api";

export const dashboardKeys = {
  systemEvents: (
    account: "all" | number,
    page: number,
    pageSize: number,
    type: string,
    severity: string,
    search: string,
  ) => ["system-events", account, page, pageSize, type, severity, search] as const,
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
  severity = "all",
  search = "",
) {
  return useQuery({
    queryKey: dashboardKeys.systemEvents(account, page, pageSize, type, severity, search),
    queryFn: () =>
      getSystemEvents(token as string, account, page, pageSize, type, severity, search),
    enabled: Boolean(token),
    refetchInterval: 15000,
  });
}

export function useDashboardReferencePrices(token: string | null) {
  return useQuery({
    queryKey: ["dashboard", "reference-prices"],
    queryFn: () => getDashboardReferencePrices(token as string),
    enabled: Boolean(token),
    refetchInterval: 10000,
    staleTime: 0,
  });
}

export function useDashboardMarketState(token: string | null) {
  return useQuery({
    queryKey: ["dashboard", "market-state"],
    queryFn: () => getDashboardMarketState(token as string),
    enabled: Boolean(token),
    refetchInterval: 30000,
    staleTime: 0,
  });
}

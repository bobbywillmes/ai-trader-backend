import { useQuery } from "@tanstack/react-query";
import {
  getBootstrap,
  getIndexIntraday,
  getIndexPerformance,
  getSystemEvents,
} from "./api";

export const dashboardKeys = {
  bootstrap: ["dashboard", "bootstrap"] as const,
  indexIntraday: ["dashboard", "index-intraday"] as const,
  indexPerformance: ["dashboard", "index-performance"] as const,
  systemEvents: (limit: number) => ["dashboard", "system-events", limit] as const,
};

export function useBootstrap(token: string | null) {
  return useQuery({
    queryKey: dashboardKeys.bootstrap,
    queryFn: () => getBootstrap(token as string),
    enabled: Boolean(token),
    refetchInterval: 10000,
    staleTime: 5000,
  });
}

export function useSystemEvents(token: string | null, limit = 20) {
  return useQuery({
    queryKey: dashboardKeys.systemEvents(limit),
    queryFn: () => getSystemEvents(token as string, limit),
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

export function useIndexIntraday(token: string | null) {
  return useQuery({
    queryKey: dashboardKeys.indexIntraday,
    queryFn: () => getIndexIntraday(token as string),
    enabled: Boolean(token),
    refetchInterval: 60000,
    staleTime: 30000,
  });
}

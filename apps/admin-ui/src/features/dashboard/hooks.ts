import { useQuery } from "@tanstack/react-query";
import { getBootstrap, getSystemEvents } from "./api";

export const dashboardKeys = {
  bootstrap: ["dashboard", "bootstrap"] as const,
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

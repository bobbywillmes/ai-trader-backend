import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createManualAccountSnapshot,
  getAccountSnapshots,
  getBrokerActivities,
  getTradePerformance,
  syncBrokerActivities,
} from "./api";
import type { BrokerActivitiesQuery, TradePerformanceQuery } from "./types";

export const reportsKeys = {
  accountSnapshots: (limit: number) =>
    ["reports", "accountSnapshots", limit] as const,
  brokerActivities: (query: BrokerActivitiesQuery) =>
    ["reports", "brokerActivities", query] as const,
  tradePerformance: (query: TradePerformanceQuery) =>
    ["reports", "tradePerformance", query] as const,
};

export function useAccountSnapshots(token: string | null, limit: number) {
  return useQuery({
    queryKey: reportsKeys.accountSnapshots(limit),
    queryFn: () => getAccountSnapshots(token as string, limit),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useCreateManualAccountSnapshot(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return createManualAccountSnapshot(token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports", "accountSnapshots"] });
    },
  });
}

export function useBrokerActivities(
  token: string | null,
  query: BrokerActivitiesQuery
) {
  return useQuery({
    queryKey: reportsKeys.brokerActivities(query),
    queryFn: () => getBrokerActivities(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useSyncBrokerActivities(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }

      return syncBrokerActivities(token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports", "brokerActivities"] });
    },
  });
}

export function useTradePerformance(
  token: string | null,
  query: TradePerformanceQuery
) {
  return useQuery({
    queryKey: reportsKeys.tradePerformance(query),
    queryFn: () => getTradePerformance(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

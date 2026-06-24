import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAccountSnapshotTrends,
  createManualAccountSnapshot,
  getAccountSnapshots,
  getBrokerActivities,
  getTradePerformance,
  syncBrokerActivities,
} from "./api";
import type {
  AccountSnapshotQuery,
  BrokerActivitiesQuery,
  TradePerformanceQuery,
} from "./types";

export const reportsKeys = {
  accountSnapshots: (query: AccountSnapshotQuery) =>
    ["reports", "accountSnapshots", query] as const,
  accountSnapshotTrends: (query: AccountSnapshotQuery) =>
    ["reports", "accountSnapshotTrends", query] as const,
  brokerActivities: (query: BrokerActivitiesQuery) =>
    ["reports", "brokerActivities", query] as const,
  tradePerformance: (query: TradePerformanceQuery) =>
    ["reports", "tradePerformance", query] as const,
};

export function useAccountSnapshots(
  token: string | null,
  query: AccountSnapshotQuery
) {
  return useQuery({
    queryKey: reportsKeys.accountSnapshots(query),
    queryFn: () => getAccountSnapshots(token as string, query),
    enabled: Boolean(token),
    staleTime: 15000,
  });
}

export function useAccountSnapshotTrends(
  token: string | null,
  query: AccountSnapshotQuery
) {
  return useQuery({
    queryKey: reportsKeys.accountSnapshotTrends(query),
    queryFn: () => getAccountSnapshotTrends(token as string, query),
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
      queryClient.invalidateQueries({
        queryKey: ["reports", "accountSnapshotTrends"],
      });
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

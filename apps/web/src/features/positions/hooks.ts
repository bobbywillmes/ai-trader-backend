import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAllOpenPositions,
  getTradingAccountOpenPositions,
  closeScopedPosition,
} from "./api";

export const positionKeys = {
  allOpen: ["positions", "scope", "all"] as const,
  accountOpen: (tradingAccountId: number) =>
    ["positions", "account", tradingAccountId, "open"] as const,
};

export function useAllOpenPositions(token: string | null, enabled = true) {
  return useQuery({
    queryKey: positionKeys.allOpen,
    queryFn: () => getAllOpenPositions(token as string),
    enabled: Boolean(token && enabled),
    refetchInterval: 5000,
  });
}

export function useTradingAccountOpenPositions(
  tradingAccountId: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey: tradingAccountId
      ? positionKeys.accountOpen(tradingAccountId)
      : ["positions", "account", "open"],
    queryFn: () =>
      getTradingAccountOpenPositions(tradingAccountId as number, token as string),
    enabled: Boolean(token && tradingAccountId),
    refetchInterval: 5000,
  });
}

export function useClosePosition(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { tradingAccountId: number; trackedPositionId: number }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return closeScopedPosition(input.tradingAccountId, input.trackedPositionId, token);
    },
    onSuccess: (_result, input) => {
      queryClient.invalidateQueries({ queryKey: positionKeys.allOpen });
      queryClient.invalidateQueries({ queryKey: positionKeys.accountOpen(input.tradingAccountId) });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "account", input.tradingAccountId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "scope", "all", "accounts-overview"] });
    },
  });
}

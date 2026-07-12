import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getOpenPositions,
  getTradingAccountOpenPositions,
  closePosition,
} from "./api";

export const positionKeys = {
  open: ["positions", "open"] as const,
  accountOpen: (tradingAccountId: number) =>
    ["positions", "account", tradingAccountId, "open"] as const,
};

export function useOpenPositions(token: string | null) {
  return useQuery({
    queryKey: positionKeys.open,
    queryFn: () => getOpenPositions(token as string),
    enabled: Boolean(token),
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
    mutationFn: (symbol: string) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return closePosition(symbol, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: positionKeys.open });
    },
  });
}

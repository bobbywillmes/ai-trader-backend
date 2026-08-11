import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAllOpenOrders, getTradingAccountOpenOrders, cancelOrder } from "./api";

export const orderKeys = {
  allOpen: ["orders", "scope", "all"] as const,
  accountOpen: (tradingAccountId: number) =>
    ["orders", "account", tradingAccountId, "open"] as const,
};

export function useAllOpenOrders(token: string | null, enabled = true) {
  return useQuery({ queryKey: orderKeys.allOpen, queryFn: () => getAllOpenOrders(token as string), enabled: Boolean(token && enabled), refetchInterval: 10000 });
}

export function useTradingAccountOpenOrders(
  tradingAccountId: number | undefined,
  token: string | null
) {
  return useQuery({
    queryKey: tradingAccountId
      ? orderKeys.accountOpen(tradingAccountId)
      : ["orders", "account", "open"],
    queryFn: () =>
      getTradingAccountOpenOrders(tradingAccountId as number, token as string),
    enabled: Boolean(token && tradingAccountId),
    refetchInterval: 5000,
  });
}

export function useCancelOrder(token: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { tradingAccountId: number; orderId: string }) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return cancelOrder(input.tradingAccountId, input.orderId, token);
    },
    onSuccess: (_result, input) => {
      queryClient.invalidateQueries({ queryKey: orderKeys.allOpen });
      queryClient.invalidateQueries({ queryKey: orderKeys.accountOpen(input.tradingAccountId) });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "account", input.tradingAccountId] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "scope", "all", "accounts-overview"] });
    },
  });
}

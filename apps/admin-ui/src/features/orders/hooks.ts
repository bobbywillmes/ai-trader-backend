import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getOpenOrders, getTradingAccountOpenOrders, cancelOrder } from "./api";

export const orderKeys = {
  open: ["orders", "open"] as const,
  accountOpen: (tradingAccountId: number) =>
    ["orders", "account", tradingAccountId, "open"] as const,
};

export function useOpenOrders(token: string | null) {
  return useQuery({
    queryKey: orderKeys.open,
    queryFn: () => getOpenOrders(token as string),
    enabled: Boolean(token),
    refetchInterval: 5000,
  });
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
    mutationFn: (orderId: string) => {
      if (!token) {
        throw new Error("Admin session is missing. Please log in again.");
      }
      return cancelOrder(orderId, token);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: orderKeys.open });
    },
  });
}

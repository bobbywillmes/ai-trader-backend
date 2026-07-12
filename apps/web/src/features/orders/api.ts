import { apiRequest } from "../../lib/api";
import type { OpenOrder } from "./types";

export function getOpenOrders(token: string) {
  return apiRequest<OpenOrder[]>("/api/orders/open", { token });
}

export function getTradingAccountOpenOrders(
  tradingAccountId: number,
  token: string
) {
  return apiRequest<{ orders: OpenOrder[] }>(
    `/api/trading-accounts/${tradingAccountId}/orders`,
    { token }
  );
}

export function cancelOrder(orderId: string, token: string) {
  return apiRequest<void>(`/api/orders/${encodeURIComponent(orderId)}`, {
    method: "DELETE",
    token,
  });
}

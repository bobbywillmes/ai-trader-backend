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

export function cancelOrder(
  tradingAccountId: number,
  orderId: string,
  token: string
) {
  return apiRequest<void>(
    `/api/orders/trading-accounts/${tradingAccountId}/${encodeURIComponent(orderId)}`,
    {
    method: "DELETE",
    token,
    }
  );
}

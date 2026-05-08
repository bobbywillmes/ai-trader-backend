import { apiRequest } from "../../lib/api";
import type { OpenOrder } from "./types";

export function getOpenOrders(token: string) {
  return apiRequest<OpenOrder[]>("/api/orders/open", { token });
}

export function cancelOrder(orderId: string, token: string) {
  return apiRequest<void>(`/api/orders/${encodeURIComponent(orderId)}`, {
    method: "DELETE",
    token,
  });
}

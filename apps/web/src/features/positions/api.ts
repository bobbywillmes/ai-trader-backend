import { apiRequest } from "../../lib/api";
import type { TrackedPosition } from "./types";

export function getAllOpenPositions(token: string) {
  return apiRequest<{ positions: TrackedPosition[] }>("/api/positions/open/scoped", { token });
}

export function getTradingAccountOpenPositions(
  tradingAccountId: number,
  token: string
) {
  return apiRequest<{ positions: TrackedPosition[] }>(
    `/api/trading-accounts/${tradingAccountId}/positions`,
    { token }
  );
}

export function closeScopedPosition(tradingAccountId: number, trackedPositionId: number, token: string) {
  return apiRequest<void>(`/api/positions/trading-accounts/${tradingAccountId}/${trackedPositionId}`, {
    method: "DELETE",
    token,
  });
}

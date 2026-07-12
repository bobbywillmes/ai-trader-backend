import { apiRequest } from "../../lib/api";
import type { TrackedPosition } from "./types";

export function getOpenPositions(token: string) {
  return apiRequest<TrackedPosition[]>("/api/tracked-positions/open", { token });
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

export function closePosition(symbol: string, token: string) {
  return apiRequest<void>(`/api/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
    token,
  });
}

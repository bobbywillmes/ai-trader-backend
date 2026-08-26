import { apiRequest } from "../../lib/api";
import type { LiveOperationsResponse } from "./types";
export function getLiveOperations(token: string, tradingAccountId?: number) {
  return apiRequest<LiveOperationsResponse>(tradingAccountId ? `/api/live-operations/${tradingAccountId}` : "/api/live-operations", { token });
}

import { apiRequest } from "../../lib/api";
import type {
  Strategy,
  StrategyChangeImpact,
  StrategyDetail,
  StrategyUpdateResult,
} from "./types";

export function getStrategies(token: string) {
  return apiRequest<Strategy[]>("/api/strategies", { token });
}

export function getStrategy(id: number, page: number, token: string) {
  return apiRequest<StrategyDetail>(`/api/strategies/${id}?page=${page}&pageSize=25`, {
    token,
  });
}

export function getStrategyChangeImpact(id: number, token: string) {
  return apiRequest<StrategyChangeImpact>(`/api/strategies/${id}/change-impact`, {
    token,
  });
}

export function updateStrategyEnabled(id: number, enabled: boolean, token: string) {
  return apiRequest<StrategyUpdateResult>(`/api/strategies/${id}`, {
    method: "PATCH",
    token,
    body: { enabled },
  });
}

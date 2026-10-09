import { apiRequest } from "../../lib/api";
import type {
  Strategy,
  StrategyChangeImpact,
  StrategyDetail,
  StrategyUpdateResult,
  StrategyMarketPolicyResponse,
  MarketPolicyValidation,
  MarketPolicyDimension,
} from "./types";

export function getStrategies(token: string) {
  return apiRequest<Strategy[]>("/api/strategies", { token });
}

export function getStrategyMarketPolicy(id: number, token: string) { return apiRequest<StrategyMarketPolicyResponse>(`/api/strategies/${id}/market-policy`, { token }); }
export function createStrategyMarketPolicy(id: number, token: string) { return apiRequest(`/api/strategies/${id}/market-policy`, { method: "POST", token, body: {} }); }
export function prepareStrategyMarketPolicyRevision(id: number, token: string) { return apiRequest(`/api/strategies/${id}/market-policy/revisions`, { method: "POST", token, body: {} }); }
export function updateStrategyMarketPolicyRule(id: number, revisionId: number, dimension: MarketPolicyDimension, requirement: "REQUIRED" | "IGNORED", allowedStates: string[], token: string) { return apiRequest(`/api/strategies/${id}/market-policy/revisions/${revisionId}/dimensions/${dimension}`, { method: "PATCH", token, body: { requirement, allowedStates } }); }
export function validateStrategyMarketPolicyRevision(id: number, revisionId: number, token: string) { return apiRequest<MarketPolicyValidation>(`/api/strategies/${id}/market-policy/revisions/${revisionId}/validation`, { token }); }
export function activateStrategyMarketPolicyRevision(id: number, revisionId: number, token: string) { return apiRequest(`/api/strategies/${id}/market-policy/revisions/${revisionId}/activate`, { method: "POST", token, body: {} }); }

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

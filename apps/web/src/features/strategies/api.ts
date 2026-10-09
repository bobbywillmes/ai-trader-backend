import { apiRequest } from "../../lib/api";
import type {
  Strategy,
  StrategyChangeImpact,
  StrategyDetail,
  StrategyUpdateResult,
  StrategyMarketPolicyResponse,
  MarketPolicyValidation,
  MarketPolicyRevision,
  MarketPolicyRuleDraft,
} from "./types";

export function getStrategies(token: string) {
  return apiRequest<Strategy[]>("/api/strategies", { token });
}

export function getStrategyMarketPolicy(id: number, token: string) { return apiRequest<StrategyMarketPolicyResponse>(`/api/strategies/${id}/market-policy`, { token }); }
export function createStrategyMarketPolicy(id: number, token: string) { return apiRequest(`/api/strategies/${id}/market-policy`, { method: "POST", token, body: {} }); }
export function prepareStrategyMarketPolicyRevision(id: number, token: string) { return apiRequest(`/api/strategies/${id}/market-policy/revisions`, { method: "POST", token, body: {} }); }
export function saveStrategyMarketPolicyRevision(id: number, revisionId: number, expectedConfigurationFingerprint: string, rules: MarketPolicyRuleDraft[], token: string) { return apiRequest<MarketPolicyRevision>(`/api/strategies/${id}/market-policy/revisions/${revisionId}`, { method: "PUT", token, body: { expectedConfigurationFingerprint, rules } }); }
export function validateStrategyMarketPolicyRevision(id: number, revisionId: number, token: string) { return apiRequest<MarketPolicyValidation>(`/api/strategies/${id}/market-policy/revisions/${revisionId}/validation`, { token }); }
export function activateStrategyMarketPolicyRevision(id: number, revisionId: number, expectedConfigurationFingerprint: string, token: string) { return apiRequest(`/api/strategies/${id}/market-policy/revisions/${revisionId}/activate`, { method: "POST", token, body: { expectedConfigurationFingerprint } }); }

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

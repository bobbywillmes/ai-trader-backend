import { apiRequest } from "../../lib/api";
import type { AttentionList, AttentionSummary, OperationalAttention } from "./types";
export function listOperationalAttention(token: string, search: string) { return apiRequest<AttentionList>(`/api/operational-attention${search}`, { token }); }
export function getOperationalAttentionSummary(token: string, account: string) { return apiRequest<AttentionSummary>(`/api/operational-attention/summary?account=${account}`, { token }); }
export function getOperationalAttention(token: string, id: number) { return apiRequest<OperationalAttention>(`/api/operational-attention/${id}`, { token }); }
export function acknowledgeAttention(token: string, id: number, expectedRevision: number) { return apiRequest<OperationalAttention>(`/api/operational-attention/${id}/acknowledge`, { method: "POST", token, body: { expectedRevision } }); }
export function manuallyResolveAttention(token: string, id: number, expectedRevision: number, reason: string) { return apiRequest<OperationalAttention>(`/api/operational-attention/${id}/manual-resolve`, { method: "POST", token, body: { expectedRevision, reason } }); }

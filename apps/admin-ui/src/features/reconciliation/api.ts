import { apiRequest } from "../../lib/api";

export type ReconciliationSeverity = "info" | "warn" | "critical";

export type ReconciliationFinding = {
  code: string;
  severity: ReconciliationSeverity;
  entityType: string;
  entityId: string;
  symbol: string;
  message: string;
  attentionCode?: string | null;
  details?: Record<string, unknown>;
};

export type RunReconciliationPayload = {
  persistEvents?: boolean;
  persistAttention?: boolean;
};

export type RunReconciliationResult = {
  ok: boolean;
  dryRun: boolean;
  findings: ReconciliationFinding[];
  eventCount: number;
  attentionUpdateCount: number;
  persistedEvents: boolean;
  persistedAttention: boolean;
};

export function runReconciliation(
  token: string,
  payload: RunReconciliationPayload = {}
) {
  return apiRequest<RunReconciliationResult>("/api/reconciliation/run", {
    method: "POST",
    token,
    body: payload,
  });
}
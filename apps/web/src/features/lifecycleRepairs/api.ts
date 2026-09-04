import { apiRequest } from "../../lib/api";

export type RepairConfidence = "DETERMINISTIC" | "STRONG" | "AMBIGUOUS" | "INSUFFICIENT";
export type LifecycleRepairExecution = {
  id: number; result: "SUCCEEDED" | "FAILED"; reason: string; executedAt: string;
  beforeJson: unknown; afterJson: unknown; validationJson: unknown; failureJson: unknown;
  executedByUser?: { id: number; name: string; email: string };
};
export type LifecycleRepairAction = {
  id: number; actionType: "TERMINALIZE_ORDER_LIFECYCLE" | "LINK_ENTRY_LIFECYCLE_TO_POSITION";
  ordinal: number; classification: "DETERMINISTIC" | "OPERATOR_CONFIRMATION_REQUIRED";
  generation: number; supersedesActionId: number | null; reconsiderationReason: string | null;
  status: "PROPOSED" | "APPROVED" | "REFUSED" | "APPLIED" | "VERIFIED" | "FAILED" | "SUPERSEDED";
  revision: number; actionFingerprint: string; proposedMutationsJson: unknown;
  preconditionsJson: unknown; evidenceJson: unknown; decisionReason: string | null;
  decidedAt: string | null; beforeJson: unknown; afterJson: unknown; verificationJson: unknown;
  executions: LifecycleRepairExecution[];
};
export type LifecycleRepairCase = {
  id: number; repairType: "RESOLVE_POSITION_ATTRIBUTION" | "REPAIR_HISTORICAL_ENTRY_LIFECYCLE"; repairVersion: number;
  generation: number; operationalAttentionId: number | null; supersedesCaseId: number | null;
  impact: "LOCAL_ONLY"; targetType: string; targetId: string; confidence: RepairConfidence;
  resolutionSource: string | null; diagnosticFingerprint: string; localLifecycleFingerprint?: string; configurationFingerprint?: string | null; evidenceJson: Record<string, unknown>;
  candidateResolutionsJson: unknown[]; rejectedAlternativesJson: unknown[];
  beforeJson: unknown; proposedMutationsJson: unknown; preconditionsJson: unknown;
  brokerImpactJson: Record<string, string>; executableAtCreation: boolean;
  nonExecutableReasonsJson: Array<{ code: string; message: string }>;
  createdAt: string; expiresAt: string; expired: boolean; superseded: boolean; executed: boolean; executable: boolean;
  tradingAccount: { id: number; displayName: string; environment: "PAPER" | "LIVE" };
  executions: LifecycleRepairExecution[];
  actions?: LifecycleRepairAction[];
};

export function listLifecycleRepairs(token: string, tradingAccountId?: number) {
  const query = tradingAccountId ? `?tradingAccountId=${tradingAccountId}` : "";
  return apiRequest<{ cases: LifecycleRepairCase[] }>(`/api/lifecycle-repairs${query}`, { token });
}
export function previewHistoricalEntryLifecycle(token: string, attentionId: number) {
  return apiRequest<{ case: LifecycleRepairCase }>("/api/lifecycle-repairs/historical-entry/preview", { method: "POST", token, body: { attentionId } });
}
export function decideLifecycleRepairAction(token: string, input: { actionId: number; expectedRevision: number; decision: "APPROVE" | "REFUSE"; reason: string }) {
  const { actionId, ...body } = input;
  return apiRequest<{ action: LifecycleRepairAction }>(`/api/lifecycle-repairs/actions/${actionId}/decision`, { method: "POST", token, body });
}
export function applyLifecycleRepairAction(token: string, input: { actionId: number; expectedRevision: number; reason: string; confirmation: string; attemptKey: string }) {
  const { actionId, ...body } = input;
  return apiRequest<{ execution: LifecycleRepairExecution; idempotent: boolean }>(`/api/lifecycle-repairs/actions/${actionId}/apply`, { method: "POST", token, body });
}
export function reconsiderLifecycleRepairAction(token: string, input: { actionId: number; expectedRevision: number; reason: string }) {
  const { actionId, ...body } = input;
  return apiRequest<{ action: LifecycleRepairAction }>(`/api/lifecycle-repairs/actions/${actionId}/reconsider`, { method: "POST", token, body });
}
export function diagnosePositionAttribution(token: string, tradingAccountId: number, trackedPositionId: number) {
  return apiRequest<{ case: LifecycleRepairCase }>("/api/lifecycle-repairs/diagnose", { method: "POST", token, body: { repairType: "RESOLVE_POSITION_ATTRIBUTION", tradingAccountId, trackedPositionId } });
}
export function applyLifecycleRepair(token: string, input: { caseId: number; reason: string; confirmation: string; attemptKey: string }) {
  const { caseId, reason, confirmation, attemptKey } = input;
  return apiRequest<{ case: LifecycleRepairCase; execution: LifecycleRepairExecution; idempotent: boolean }>(`/api/lifecycle-repairs/${caseId}/apply`, {
    method: "POST",
    token,
    body: { reason, confirmation, attemptKey },
  });
}

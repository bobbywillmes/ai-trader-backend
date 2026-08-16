import { apiRequest } from "../../lib/api";

export type RepairConfidence = "DETERMINISTIC" | "STRONG" | "AMBIGUOUS" | "INSUFFICIENT";
export type LifecycleRepairExecution = {
  id: number; result: "SUCCEEDED" | "FAILED"; reason: string; executedAt: string;
  beforeJson: unknown; afterJson: unknown; validationJson: unknown; failureJson: unknown;
  executedByUser?: { id: number; name: string; email: string };
};
export type LifecycleRepairCase = {
  id: number; repairType: "RESOLVE_POSITION_ATTRIBUTION"; repairVersion: number;
  impact: "LOCAL_ONLY"; targetType: string; targetId: string; confidence: RepairConfidence;
  resolutionSource: string | null; diagnosticFingerprint: string; localLifecycleFingerprint?: string; configurationFingerprint?: string | null; evidenceJson: Record<string, unknown>;
  candidateResolutionsJson: unknown[]; rejectedAlternativesJson: unknown[];
  beforeJson: unknown; proposedMutationsJson: unknown; preconditionsJson: unknown;
  brokerImpactJson: Record<string, string>; executableAtCreation: boolean;
  nonExecutableReasonsJson: Array<{ code: string; message: string }>;
  createdAt: string; expiresAt: string; expired: boolean; superseded: boolean; executed: boolean; executable: boolean;
  tradingAccount: { id: number; displayName: string; environment: "PAPER" | "LIVE" };
  executions: LifecycleRepairExecution[];
};

export function listLifecycleRepairs(token: string, tradingAccountId?: number) {
  const query = tradingAccountId ? `?tradingAccountId=${tradingAccountId}` : "";
  return apiRequest<{ cases: LifecycleRepairCase[] }>(`/api/lifecycle-repairs${query}`, { token });
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

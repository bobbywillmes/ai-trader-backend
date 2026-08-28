export type AttentionSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type AttentionStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export type OperationalAttention = {
  id: number; tradingAccountId: number; code: string; source: string; status: AttentionStatus; severity: AttentionSeverity;
  title: string; message: string; detailsJson: unknown; occurrenceCount: number; firstObservedAt: string; lastObservedAt: string;
  revision: number; resolutionPolicy: "AUTHORITATIVE_ONLY" | "MANUAL_ALLOWED"; acknowledgedAt: string | null; resolvedAt: string | null;
  resolutionReason: string | null; trackedPositionId: number | null; orderIntentId: number | null; brokerOrderId: number | null;
  tradingAccount: { id: number; displayName: string; environment: "PAPER" | "LIVE" };
  links: { account: string; reconciliation: string; position: string | null; order: string | null; systemEvents: string };
  allowedActions: { acknowledge: boolean; manualResolve: boolean };
  evidenceEvents?: Array<{ relationKind: string; createdAt: string; systemEvent: { id: number; type: string; message: string; severity: AttentionSeverity; createdAt: string; payloadJson: unknown } }>;
};
export type AttentionList = { items: OperationalAttention[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } };
export type AttentionSummary = { totalUnresolved: number; openCount: number; acknowledgedCount: number; bySeverity: Record<AttentionSeverity, number>; highestSeverity: AttentionSeverity | null; criticalLiveAccounts: number[]; preview: OperationalAttention[]; evidenceAt: string };

export type AttentionSeverity = "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export type AttentionStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export type OperationalAttention = {
  id: number;
  tradingAccountId: number;
  code: string;
  source: string;
  status: AttentionStatus;
  severity: AttentionSeverity;
  title: string;
  message: string;
  detailsJson: unknown;
  occurrenceCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
  revision: number;
  resolutionPolicy: "AUTHORITATIVE_ONLY" | "MANUAL_ALLOWED";
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionReason: string | null;
  trackedPositionId: number | null;
  orderIntentId: number | null;
  brokerOrderId: number | null;
  tradingAccount: {
    id: number;
    displayName: string;
    environment: "PAPER" | "LIVE";
  };
  links: {
    account: string;
    reconciliation: string;
    position: string | null;
    order: string | null;
    systemEvents: string;
  };
  allowedActions: { acknowledge: boolean; manualResolve: boolean };
  evidenceEvents?: Array<{
    relationKind: string;
    createdAt: string;
    systemEvent: {
      id: number;
      type: string;
      message: string;
      severity: AttentionSeverity;
      createdAt: string;
      payloadJson: unknown;
    };
  }>;
};
export type AttentionList = {
  items: OperationalAttention[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
};
export type AttentionSummary = {
  totalUnresolved: number;
  openCount: number;
  acknowledgedCount: number;
  bySeverity: Record<AttentionSeverity, number>;
  highestSeverity: AttentionSeverity | null;
  criticalLiveAccounts: number[];
  preview: OperationalAttention[];
  evidenceAt: string;
};
export type RemainingExposureClosePreview = {
  attentionId: number;
  revision: number;
  status: AttentionStatus;
  severity: AttentionSeverity;
  tradingAccount: {
    id: number;
    displayName: string;
    environment: "PAPER" | "LIVE";
  };
  trackedPositionId: number | null;
  securityId: number | null;
  symbol: string | null;
  trackedQuantity: string | null;
  attributedExitFilledQuantity: string;
  expectedRemainingQuantity: string | null;
  brokerPosition: {
    side: "long" | "short" | null;
    heldQuantity: string | null;
    availableQuantity: string | null;
  };
  activeOrders: Array<{
    brokerOrderId: string;
    clientOrderId: string;
    side: "buy" | "sell";
    type: string;
    status: string;
    remainingQty: string | null;
    matchingCorrectiveAttempt: boolean;
  }>;
  marketSession: { marketOpen: boolean; fetchedAt: string } | null;
  deploymentAuthority: { role: string; canWrite: boolean };
  liveRiskReducingAuthorization: {
    effective: boolean;
    reason: string | null;
  } | null;
  eligible: boolean;
  canExecute: boolean;
  observedAt: string;
  validUntil: string;
  previewFingerprint: string;
  blockingReasons: Array<{ code: string; message: string; nextAction: string }>;
  explanation: string;
  nextAction: string;
};

export type EvidenceState = "PRE_ROLLOUT" | "POST_EPOCH_MISSING_CAPTURE" | "UNENROLLED" | "LEGACY_UNKNOWN" | "NONE_VISIBLE" | "EXACT";
export type ComparisonState = "NOT_SCHEDULED" | "PENDING" | "COMPLETED" | "INSUFFICIENT_EVIDENCE" | "TECHNICAL_FAILURE" | "TERMINAL_RETRY_EXHAUSTED";

export type EvidenceDelivery = {
  status: "PENDING" | "CLAIMED" | "RETRY_WAIT" | "COMPLETED" | "TERMINAL_FAILURE";
  attemptCount: number;
  nextAttemptAt: string;
  lastErrorCode: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceGate = {
  id: number;
  ordinal: number;
  dimension: "TREND" | "VOLATILITY" | "BREADTH" | "PARTICIPATION" | "INTRADAY_STRESS";
  algorithmVersion: string;
  requirement: "REQUIRED" | "IGNORED";
  outcome: "PASS" | "BLOCKED" | "INSUFFICIENT_EVIDENCE" | "IGNORED";
  observedState: string | null;
  sourceHealth: "AVAILABLE" | "MISSING" | "UNAVAILABLE" | "FAILED" | null;
  sourceAssessmentId: number | null;
  allowedStates?: string[];
  reasonCode: string;
  createdAt: string;
};

export type EvidenceAttempt = {
  id: number;
  attempt: number;
  evidenceAsOf: string;
  evaluationVersion: string;
  enrollmentDisposition: string;
  outcome: "ALLOWED" | "BLOCKED" | "INSUFFICIENT_EVIDENCE" | "TECHNICAL_FAILURE";
  reasonCode: string;
  authority: "COMPARE_ONLY";
  tradingEffect: "NONE";
  createdAt: string;
  gates: EvidenceGate[];
};

export type EvidenceComparison = {
  state: ComparisonState;
  delivery: EvidenceDelivery | null;
  attempts: EvidenceAttempt[];
  attemptBounds: { returned: number; limit: number; total: number; hasMore: boolean };
};

export type BrokerOpportunity = {
  id: number;
  opportunitySequence: number;
  clientOrderId: string;
  enrollmentGenerationId: number | null;
  policyRevisionId: number | null;
  marketRegimeAssessmentId: number | null;
  sourceSetFingerprint?: string | null;
  compositionCapture: "EXACT" | "NONE_VISIBLE" | "LEGACY_UNKNOWN";
  applicability: string;
  comparisonMode: "COMPARE_ONLY";
  tradingEffect: "NONE";
  opportunityAt: string;
  createdAt: string;
  comparison: EvidenceComparison;
  events: BrokerOpportunityEvent[];
  relatedBrokerOrders: Array<{ id: number; broker: string; brokerOrderId: string; clientOrderId: string; symbol: string; side: string; status: string; trackedPositionId: number | null; createdAt: string; updatedAt: string }>;
  eventPagination: EvidencePagination;
};

export type BrokerOpportunityEvent = {
  id: number;
  sequence: number;
  eventType: "OPPORTUNITY_CAPTURED" | "ADAPTER_DISPATCH_REACHED" | "BROKER_RESPONSE_CONFIRMED" | "BROKER_REJECTED" | "BROKER_ORDER_MATERIALIZED" | "DELIVERY_UNCERTAIN" | "DEFINITELY_NOT_SENT" | "DEFERRED" | "RECOVERY_FOUND" | "RECOVERY_ABSENCE_CONFIRMED" | "RECOVERY_INCONCLUSIVE" | "MISSING_OBSERVATION";
  occurredAt: string;
  createdAt: string;
  details: null | { source: string | null; brokerOrderId: string | null; brokerStatus: string | null; classification: string | null; statusCode: number | null; adapter: string | null; operation: string | null; clientOrderId: string | null; captureVersion: number | null };
};

export type EvidencePagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
};

export type OrderOperationalEvidenceResponse = {
  authority: { comparisonMode: "COMPARE_ONLY"; tradingEffect: "NONE"; enforcementAuthority: false };
  orderIntent: {
    id: number;
    source: string;
    symbol: string;
    side: string;
    orderType: string;
    timeInForce: string;
    qty: number | null;
    notional: number | null;
    limitPrice: number | null;
    extendedHours: boolean;
    clientOrderId: string | null;
    status: string;
    blockReason: string | null;
    createdAt: string;
    updatedAt: string;
    tradingAccountId: number | null;
    tradingAccount: { id: number; displayName: string; broker: string; environment: string } | null;
    subscriptionId: number | null;
    subscriptionKey: string | null;
    tradingAccountSubscriptionId: number | null;
    assignment: { id: number; subscription: { id: number; key: string; name: string; strategy: { id: number; key: string; name: string } } } | null;
    brokerOrders: Array<{ id: number; broker: string; brokerOrderId: string; clientOrderId: string; symbol: string; side: string; status: string; trackedPositionId: number | null; createdAt: string; updatedAt: string }>;
    trackedPositionId: number | null;
    trackedPosition: { id: number; symbol: string; side: string; status: string; openedAt: string; closedAt: string | null } | null;
  };
  intentStage: {
    state: EvidenceState;
    rollout: { effectiveEpoch: string | null; deployedAt: string; disabledAt: string | null } | null;
    coverage: null | {
      id: number;
      provenance: string;
      compositionCapture: "EXACT" | "NONE_VISIBLE" | "LEGACY_UNKNOWN";
      captureSchemaVersion: number;
      comparisonMode: "COMPARE_ONLY";
      tradingEffect: "NONE";
      capturedAt: string;
      enrollmentGenerationId: number | null;
      boundPolicyRevisionId: number | null;
      activePolicyRevisionId: number | null;
      marketRegimeAssessmentId: number | null;
      enrollmentGeneration: null | { id: number; generation: number; status: string; strategyId: number; policyRevisionId: number; preparedAt: string; activatedAt: string | null; disabledAt: string | null };
      boundPolicyRevision: null | { id: number; revision: number; status: string };
      activePolicyRevision: null | { id: number; revision: number; status: string };
      marketComposition: null | {
        id: number; compositionVersion: string; targetAt: string; observedAt: string; dataThroughAt: string | null; validUntil: string | null;
        publicationStatus: string; evidenceHealth: string; publicationReasonCode: string | null; evidenceReasonCode: string | null; completedAt: string;
        sourceSetFingerprint?: string;
      };
    };
    comparison: EvidenceComparison;
  };
  brokerStage: {
    state: "BROKER_LOOKUP_FOUND_WITHOUT_NEW_POST" | "MULTIPLE_POST_OPPORTUNITIES" | "POST_OPPORTUNITY_RECORDED" | "MISSING_OBSERVATION" | "NO_POST_OPPORTUNITY";
    stateSource: "DERIVED_FROM_LIFECYCLE" | "RECORDED_EVIDENCE";
    opportunities: BrokerOpportunity[];
    pagination: EvidencePagination;
    unboundMissingObservations: BrokerOpportunityEvent[];
    unboundEventPagination: EvidencePagination;
  };
  relatedRecords: { entryDecisionId: number | null; brokerOrderRecordIds: number[]; trackedPositionId: number | null; tradingAccountId: number | null; accountSubscriptionId: number | null; subscriptionId: number | null; strategyId: number | null; marketRegimeAssessmentIds: number[] };
};

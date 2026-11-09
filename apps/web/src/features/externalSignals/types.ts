// HTTP DTOs follow the existing feature-local convention (dates are ISO strings).
export const providers = ["TRADINGVIEW", "TRENDSPIDER", "GENERIC_WEBHOOK"] as const;
export type Provider = typeof providers[number];
export const events = ["ENTRY_LONG", "EXIT_LONG"] as const;
export const statuses = ["NORMALIZED", "DUPLICATE", "REJECTED"] as const;
export const timeframes = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export const rejectionCodes = ["SOURCE_DISABLED", "INVALID_CONTENT_TYPE", "INVALID_JSON", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_SCHEMA_VERSION", "INVALID_ENVELOPE", "UNKNOWN_STRATEGY_BINDING", "STRATEGY_BINDING_DISABLED", "STRATEGY_REVISION_MISMATCH", "UNKNOWN_SYMBOL", "INVALID_EVENT", "INVALID_TIMEFRAME", "INVALID_TIMESTAMP", "EVENT_FINGERPRINT_CONFLICT", "EVENT_KEY_CONFLICT"] as const;
export type Source = { id: number; name: string; provider: Provider; enabled: boolean; authMethod: "URL_TOKEN"; createdAt: string; updatedAt: string };
export type Binding = { id: number; signalSourceId: number; strategyId: number; externalStrategyKey: string; revisions: Revision[]; enabled: boolean; createdAt: string; updatedAt: string };
export type Signal = {
  strategySignalRevision?: Revision | null;
  routingRun?: { id: number; authorityMode: AuthorityMode; status: "STOPPED" | "COMPLETED"; stopReason: string | null; routeCount: number; routes: SignalRoute[] } | null;
  id: number; signalSourceId: number; strategySignalBindingId: number; strategyId: number; securityId: number;
  schemaVersion: number; externalEventKey: string | null; externalEventId:string|null;externalTradeCycleRef:string|null;externalSignalTradeCycleId:number|null; eventFingerprint: string | null; strategyRevision: number | null; legacyStrategyRevision: string | null; strategySignalRevisionId: number | null; event: typeof events[number];
  symbol: string; timeframe: string; signalTime: string; barTime: string | null; metadata: unknown;
  canonicalPayloadHash: string; createdAt: string;
};
export type Delivery = {
  id: number; signalSourceId: number; signalId: number | null; requestId: string;
  receivedAt: string; processedAt: string; status: typeof statuses[number]; contentType: string | null;
  bodySizeBytes: number; rawPayloadHash: string; rawPayloadRedacted: unknown;
  rejectionCode: typeof rejectionCodes[number] | null; rejectionDetails: unknown; createdAt: string;
};
export type CorrelationWork = { id: number; signalId: number; event: typeof events[number]; status: 'PENDING'|'CLAIMED'|'RETRY_WAIT'|'COMPLETED'|'FAILED'; attemptCount: number; leaseOwner: string|null; leaseExpiresAt: string|null; nextAttemptAt: string; lastErrorCode: string|null; completedAt: string|null; createdAt: string; updatedAt: string; ageMs: number; stalledLease: boolean };
export type ExitResolutionState='CORRELATION_PENDING'|'RECORDED_HELD_BEHIND_RESERVATION'|'RECORDED_SHADOW'|'NO_EXPOSURE_TERMINAL'|'RETENTION_EXPIRED'|'FAILED'|'INCONSISTENT';
export type ExitObligation = { signalId: number; externalEventId:string|null;workId: number|null; workStatus: string; acceptedAt: string; decisionCount: number; resolutionState:ExitResolutionState;unresolved: boolean;attentionRequired:boolean;reasonCode: string;brokerExitApplied:false };
export type CorrelationDecision={id:number;signalId:number;accountCycleId:number|null;signalRouteId:number|null;decisionType:string;authorityMode:'SHADOW';rolloutGenerationId:number|null;reservationKey:string|null;reasonCode:string;evidenceJson:unknown;createdAt:string;rolloutGeneration:null|{id:number;direction:string;generation:number;enabled:boolean;authorityMode:'SHADOW';effectiveAt:string;configurationFingerprint:string}};
export type OperationsCycle = { id:number; externalTradeCycleRef:string; status:string; terminalAt:string|null; terminalReasonCode:string|null; createdAt:string; updatedAt:string; shadowOnly:true; actualExecutionAuthority:'NONE'; hypotheticalEntryAuthority:string; unresolvedExitCount:number;attentionExitCount:number; exitObligations:ExitObligation[]; work:CorrelationWork[]; security:{id:number;symbol:string}; binding:{id:number;externalStrategyKey:string;signalSource:{id:number;name:string};strategy:{id:number;key:string;name:string}}; revision:{id:number;revision:number;authorityMode:AuthorityMode;status:string}; signals:Signal[]; accountCycles:Array<{id:number;status:string;tradingAccountId:number;tradingAccountSubscriptionId:number;subscriptionId:number;entrySignalRouteId:number;entryRolloutGenerationId:number|null;entryReservationKey:string|null;pendingExitAcceptedAt:string|null;terminalAt:string|null;terminalReasonCode:string|null;noExposureProof:string|null;tradingAccount:{id:number;displayName:string;environment:string};correlationDecisions:CorrelationDecision[]}>; correlationDecisions:CorrelationDecision[]; executionLifecycle?: ExecutionLifecycle };
export type Resources = { sources: Source; bindings: Binding; signals: Signal; deliveries: Delivery; operations: OperationsCycle };
export type Section = keyof Resources;
export type Pagination = { page: number; pageSize: number; total: number; totalPages: number };
export type ListResult<K extends Section> = { [P in K]: Resources[P][] } & { pagination: Pagination };
export type OperationsResult = { cycles: OperationsCycle[]; summary:{shadowOnly:true;totalCycles:number;unresolvedExitObligations:number;work:Record<string,number>;stalledLeases:number;evaluatedAt:string};pagination:Pagination };
export type CreateSource = Pick<Source, "name" | "provider"> & { enabled: boolean };
export type UpdateSource = Partial<Pick<Source, "name" | "enabled">>;
export type CreateBinding = Pick<Binding, "signalSourceId" | "strategyId" | "externalStrategyKey" | "enabled">;
export type UpdateBinding = Pick<Binding, "enabled">;

export const authorityModes = ["EVIDENCE_ONLY", "EVALUATION_ONLY", "TRADE_ELIGIBLE"] as const;
export type AuthorityMode = typeof authorityModes[number];
export type Revision = { id: number; strategySignalBindingId: number; revision: number; authorityMode: AuthorityMode; status: "PREPARED" | "ACTIVE" | "RETIRED"; changeNote: string | null; createdAt: string; activatedAt: string | null; retiredAt: string | null };
export type SignalRoute = { id: number; tradingAccountId: number; tradingAccountSubscriptionId: number; subscriptionId: number;
  evaluationVersion?: number | null;
  evaluation?: SignalEvaluation | null;
  marketEligibilityAttempts?: SignalRouteMarketEligibilityAttempt[];
  targetSnapshot: { tradingAccountName: string; subscriptionKey: string; subscriptionName: string; strategy: { id: number; key: string; name: string }; security: { id: number; symbol: string } };
};

export type SignalRouteMarketEligibilityAttempt = {
  id: number; signalRouteId: number; attempt: number; integrationVersion: string;
  status: 'COMPLETED' | 'FAILED' | 'NOT_APPLICABLE'; strategyId: number;
  eligibilityDecisionId: number | null; reasonCode: string; startedAt: string; completedAt: string;
  evidenceJson: unknown; eligibilityDecision: null | {
    id: number; outcome: 'ALLOWED' | 'BLOCKED' | 'INSUFFICIENT_EVIDENCE'; reasonCode: string;
    evaluatedAt: string; validUntil: string | null; policyRevisionId: number | null; marketRegimeAssessmentId: number | null;
    evaluationVersion: string; currentFreshness: 'CURRENT' | 'EXPIRED' | 'POLICY_SUPERSEDED' | 'COMPOSITION_SUPERSEDED'; policyRevision: { id: number; revision: number; activatedAt: string | null } | null;
    marketRegimeAssessment: { id: number; compositionVersion: string; targetAt: string; observedAt: string } | null;
    gates: Array<{ id: number; ordinal: number; dimension: string; algorithmVersion: string; requirement: string; outcome: string; observedState: string | null; sourceHealth: string | null; sourceAssessmentId: number | null; allowedStatesJson: string[]; reasonCode: string }>;
  };
};

export type SignalEvaluation = {
  id: number; signalRouteId: number; evaluationVersion: number; event: typeof events[number];
  intent: 'ENTRY' | 'EXIT'; riskDirection: 'RISK_INCREASING' | 'RISK_REDUCING';
  status: 'COMPLETED' | 'FAILED'; outcome: 'ELIGIBLE' | 'BLOCKED' | 'NO_ACTION' | null; reasonCode: string | null;
  prospectiveExitManagementMode: string | null; positionExitManagementMode: string | null;
  trackedPositionId: number | null; positionExitStateId: number | null;
  startedAt: string; completedAt: string; createdAt: string;
  gates: { id: number; sequence: number; gateKey: string; result: string; reasonCode: string | null; evidenceJson: unknown; evaluatedAt: string }[];
};

// ---- Execution lifecycle projection (C3B.3-1, read-only). Dates are ISO strings. ----
export type ExecutionLifecycleStage = 'CORRELATION_IN_PROGRESS' | 'ADMISSION_AWAITING_PROCESSING' | 'PENDING_MARKED_INTENT' | 'C2_WORKER_CLAIMED' | 'AUTHORIZATION_COMMITTED' | 'POST_SUBMISSION_BROKER_LIFECYCLE' | 'BLOCKED_EXPIRED_OR_TERMINALIZED' | 'NOT_AN_EXECUTION_CANDIDATE' | 'MISSING_OR_INCONSISTENT_EVIDENCE';
export type SourceLifecycleStage = 'NOT_AN_EXECUTION_CANDIDATE' | 'CORRELATION_IN_PROGRESS' | 'ACCOUNT_LIFECYCLES_PROJECTED';
export type ReadinessScope = 'PAPER_BUY' | 'NOT_APPLICABLE_NO_INTENT' | 'OUT_OF_SCOPE';
export type AssignmentAuthorityState = 'NOT_YET_FROZEN' | 'FROZEN_EFFECTIVE' | 'FROZEN_NOT_EFFECTIVE';
export type TruncationMetadata = { returned: number; total: number; truncated: boolean };
export type LifecycleCapabilities = { finalizationScheduling: string; brokerPost: string; tradingViewSellExecution: string; tradingViewLiveExecution: string };
type Id = number | string;
export type LifecycleExposureEvent = { id: Id; eventType: string; createdAt: string | null; evidenceJson?: unknown };
export type LifecycleBrokerOrder = { id: Id; brokerOrderId: string | null; clientOrderId: string | null; side: string | null; status: string | null; createdAt: string | null; updatedAt: string | null };
export type LifecycleBrokerActivity = { id: Id; activityId: string | null; activityType: string | null; activityCategory: string | null; orderId: string | null; transactionTime: string | null; createdAt: string | null };
export type LifecycleAttention = { id: Id; code: string | null; source: string | null; status: string; severity: string | null; title: string | null; resolutionPolicy: string | null; firstObservedAt: string | null; lastObservedAt: string | null; resolvedAt: string | null };
export type AccountCycleLifecycle = {
  accountCycleId: number;
  lifecycle: { stage: ExecutionLifecycleStage; reasonCode: string };
  readiness: {
    scope: ReadinessScope;
    frozenGeneration: { id: number | null; generation: number | null; enabled: boolean | null; authorityMode: string | null; effectiveAt: string | null };
    rolloutRelationship: { activeExecutionGenerationId: number | null; activeDispatchGenerationId: number | null; matchesExecution: boolean; matchesDispatch: boolean };
    executionState: { version: number | null; activatedAt: string | null };
    dispatchState: { version: number | null; activatedAt: string | null };
    effectiveAssignmentAuthority: boolean;
    /** Additive diagnostic; absent from servers older than this checkpoint. Never confers eligibility. */
    assignmentAuthorityState?: AssignmentAuthorityState;
    accountOperational: boolean;
    assignmentOperational: boolean;
    receipt: { signalId: number | null; receivedAt: string | null; freshness: string };
    c2WorkerClaimPresent: boolean;
    authorizationDeadlineStatus: 'NOT_COMMITTED' | 'OPEN' | 'EXPIRED';
  };
  evidence: {
    executionObligation: null | { id: number; createdAt: string | null; executionEpochAt: string | null; authorizationId: number | null; rolloutGenerationId: number | null };
    marketIntelligenceObligation: null | { id: number; frozenAt: string | null; validUntil: string | null };
    orderIntent: null | { id: number; status: string; clientOrderId: string | null; createdAt: string | null; updatedAt: string | null; blockReason: string | null };
    exposure: null | { id: number; status: string; acquiredAt: string | null; releasedAt: string | null; releaseReason: string | null; held: boolean };
    workerClaim: null | { id: number; claimedAt: string | null; dispatchStateVersion: number | null };
    authorization: { pairPresent: boolean; status: string; expired: boolean; tradingViewConsumption: null | { id: number; authorizedAt: string | null; deadlineAt: string | null; consumedAt: string | null }; marketIntelligenceConsumption: null | { id: number; consumedAt: string | null } };
    brokerSendPermissionEstablished: boolean;
    broker: { attributionProvenance: string; absenceIsAuthoritativeNonDeliveryProof: boolean; orderEvidencePresent: boolean; activityEvidencePresent: boolean; orders: LifecycleBrokerOrder[]; ordersMetadata: TruncationMetadata; activities: LifecycleBrokerActivity[]; activitiesMetadata: TruncationMetadata };
    exposureEvents: LifecycleExposureEvent[];
    exposureEventsMetadata: TruncationMetadata;
  };
  recovery: {
    retainedExposureReviewRequired: boolean;
    retainedExposureReasonCode: string | null;
    authoritativeReconciliationRequired: boolean;
    unresolvedAuthoritativeOnlyCount: number;
    activeAttentionCount: number;
    activeOperationalAttention: LifecycleAttention[];
    activeOperationalAttentionMetadata: TruncationMetadata;
    operationalAttention: LifecycleAttention[];
    operationalAttentionMetadata: TruncationMetadata;
  };
};
export type ExecutionLifecycle = {
  observedAt: string;
  readinessMayChangeAfterObservation: boolean;
  capabilities: LifecycleCapabilities;
  sourceLifecycle?: { stage: SourceLifecycleStage; reasonCode: string };
  accountCycles: AccountCycleLifecycle[];
};

export type ExecutionRolloutStatus = {
  activeExecutionGenerationId: number | null; executionEpochAt: string | null; rolloutStateVersion: number;
  generations: Array<{ id: number; generation: number; direction: string; enabled: boolean; authorityMode: string; effectiveAt: string }>;
  activationEvents: Array<{ id: number; rolloutGenerationId: number; action: string; reason: string; createdAt: string }>;
};
export type DispatchStatus = { state: { version: number; activeRolloutGenerationId: number | null; activatedAt: string | null }; activationEvents: Array<{ id: number; rolloutGenerationId: number; action: string; stateVersion: number; reason: string; createdAt: string }> };
export type EntryExecutionAuthorization = { id: number; rolloutGenerationId: number; authorizationSequence: number; status: string; tradingAccountId: number; tradingAccountSubscriptionId: number; subscriptionId: number; securityId: number; signalSourceId: number; strategySignalBindingId: number; strategySignalRevisionId: number; strategyRevision: number; authorizedAt: string; revokedAt: string | null; invalidatedAt: string | null; invalidationReasonCode: string | null };

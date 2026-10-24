export const LIFECYCLE_EVIDENCE_INVENTORY_SCHEMA_VERSION = 'POSITION_LIFECYCLE_EVIDENCE_INVENTORY_V1' as const;
export const LIFECYCLE_EVIDENCE_CLASSIFIER_VERSION = 'POSITION_LIFECYCLE_EVIDENCE_CLASSIFIER_V1' as const;

export type ShadowLifecycleClassification =
  | 'COMPLETE_LOCAL_ORDER_CHAIN'
  | 'POSITIVE_EXTERNAL_ORIGIN'
  | 'UNKNOWN_INCOMPLETE_LINEAGE'
  | 'CONTRADICTORY_EVIDENCE';

export type InventoryConfidence = 'DETERMINISTIC' | 'VERIFIED' | 'INSUFFICIENT' | 'CONTRADICTORY';
export type EvidenceRole = 'SUPPORTING' | 'CORROBORATING' | 'CONTRADICTING';

export type LifecycleInventoryReasonCode =
  | 'LOCAL_ENTRY_CHAIN_COMPLETE'
  | 'POSITION_ACCOUNT_MISSING'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'BROKER_MISMATCH'
  | 'SECURITY_SYMBOL_MISMATCH'
  | 'CREATION_AUTHORITY_HISTORICAL_NULL'
  | 'ORDER_INTENT_LINK_MISSING'
  | 'MULTIPLE_ENTRY_INTENTS_UNRECONCILED'
  | 'ENTRY_INTENT_NOT_BUY'
  | 'BROKER_ORDER_LINK_MISSING'
  | 'BROKER_ORDER_IDENTITY_CONFLICT'
  | 'CONFIRMED_ENTRY_FILL_MISSING'
  | 'ENTRY_FILL_PARTIAL_ONLY'
  | 'EXECUTED_QUANTITY_AMBIGUOUS'
  | 'DUPLICATE_BROKER_ACTIVITY_IDENTITY'
  | 'FILL_ORDER_ID_MISMATCH'
  | 'CLIENT_ORDER_ID_MISMATCH'
  | 'DISPATCH_EVIDENCE_MISSING'
  | 'DISPATCH_EVIDENCE_CONFLICT'
  | 'ADAPTER_INVOCATION_EVIDENCE_MISSING'
  | 'FROZEN_SUBSCRIPTION_MISSING'
  | 'FROZEN_ASSIGNMENT_MISSING'
  | 'ATTRIBUTION_IDENTITY_CONFLICT'
  | 'HEURISTIC_OR_REPAIR_LINK_NOT_PROOF'
  | 'ENTRY_CLAIM_MISSING'
  | 'ENTRY_CLAIM_UNRESOLVED'
  | 'ENTRY_CLAIM_IDENTITY_CONFLICT'
  | 'NO_RECORDED_PROVENANCE_DECISION'
  | 'RECORDED_EXTERNAL_PROVENANCE_UNVERIFIED'
  | 'RECORDED_PROVENANCE_DISAGREES'
  | 'PROVENANCE_CHAIN_INVALID'
  | 'INDEPENDENT_EXTERNAL_ORIGIN_VERIFIED'
  | 'OPEN_POSITION_HAS_EXIT_STATE'
  | 'LEGACY_EXIT_CONTINUITY_REVIEW_REQUIRED'
  | 'LEGACY_EXIT_CONTINUITY_REVIEWED';

export type InventoryEvidenceReference = { kind: string; id: string; role: EvidenceRole };

export type InventoryIntentEvidence = {
  id: number; tradingAccountId: number | null; trackedPositionId: number | null; side: string; status: string;
  symbol: string; qty: number | null; clientOrderIdHash: string | null; subscriptionId: number | null;
  tradingAccountSubscriptionId: number | null;
  brokerOrders: Array<{ id: number; tradingAccountId: number | null; trackedPositionId: number | null; broker: string; brokerOrderIdHash: string; clientOrderIdHash: string; clientOrderIdMatchesIntent: boolean; side: string }>;
  fills: Array<{ id: number; activityIdHash: string; activityIdDuplicateCount: number; tradingAccountId: number | null; trackedPositionId: number | null; brokerOrderRecordId: number | null; orderIdHash: string | null; orderIdMatchesBrokerOrder: boolean; side: string | null; qty: number | null; cumQty: number | null; leavesQty: number | null }>;
  dispatch: { consumptionIds: number[]; unenforcedDispatchIds: number[]; brokerOpportunityIds: number[]; adapterMarkerEventIds: number[]; clientIdentityConsistent: boolean };
};

export type PositionLifecycleEvidenceSource = {
  identity: { trackedPositionId: number; tradingAccountId: number | null; accountBroker: string | null; positionBroker: string; environment: string | null; brokerAccountIdMasked: string | null; securityId: number; securitySymbol: string; positionSymbol: string; side: string };
  currentState: { status: string; openedAt: string; closedAt: string | null; qty: number; subscriptionId: number | null; tradingAccountSubscriptionId: number | null; configSnapshotCapturedAt: string | null };
  creationAuthority: 'EXECUTOR' | 'OBSERVER' | null;
  intents: InventoryIntentEvidence[];
  attribution: Array<{ subscriptionId: number; securityId: number; strategyId: number; exitProfileId: number; assignmentId: number | null; assignmentAccountId: number | null; assignmentSubscriptionId: number | null }>;
  exitState: { id: number; exitManagementModeSnapshot: string; hasOwnershipProvenance: boolean; status: string; hasProtectiveOrderState: boolean } | null;
  claim: { id: number; tradingAccountId: number; securityId: number; orderIntentId: number | null; trackedPositionId: number | null; status: string; releasedAt: string | null; events: Array<{id:number;eventType:string}> } | null;
  provenance: { chainValid: boolean; decisionIds: number[]; effectiveDecisionId: number | null; origin: string | null; ownership: string | null; legacyExitContinuityAuthorized: boolean; classifierVersion: string | null; evidenceFingerprint: string | null; trust: 'UNVERIFIED' | 'VERIFIED' };
  operationalAttention: Array<{id:number;code:string;status:string;source:string}>;
};

export type PositionLifecycleEvidenceResult = PositionLifecycleEvidenceSource & {
  shadowClassification: ShadowLifecycleClassification;
  confidence: InventoryConfidence;
  reasonCodes: LifecycleInventoryReasonCode[];
  evidence: InventoryEvidenceReference[];
  readiness: { structurallyCompleteLocalLineage: boolean; independentlySupportedLocalExecution: boolean; legacyExitContinuityReviewRequired: boolean };
};

export type InventoryGroupSummary = {
  databaseTier: 'DEVELOPMENT'; accountEnvironment: string | null; broker: string; positionStatus: string;
  positions: number; classifications: Record<ShadowLifecycleClassification, number>;
  completeLocalOwnershipEvidence: number; incompleteLocalLineage: number; contradictoryEvidence: number; noAccountAttribution: number;
  openPositionsWithExitState: number; openPositionsRequiringLegacyExitContinuityReview: number;
  positionsWithUnresolvedClaimsOrRecovery: number;
};

export type PositionLifecycleEvidenceInventoryReport = {
  schemaVersion: typeof LIFECYCLE_EVIDENCE_INVENTORY_SCHEMA_VERSION;
  classifierVersion: typeof LIFECYCLE_EVIDENCE_CLASSIFIER_VERSION;
  generatedAt: string;
  databaseIdentity: { database: string; host: string | null; port: number | null; user: string; transactionReadOnly: boolean; tier: 'DEVELOPMENT' };
  filters: { afterPositionId: number | null; pageSize: number };
  summary: { totalPositions: number; classifications: Record<ShadowLifecycleClassification, number>; reasonCodeCounts: Partial<Record<LifecycleInventoryReasonCode, number>>; readiness: Omit<InventoryGroupSummary,'databaseTier'|'accountEnvironment'|'broker'|'positionStatus'|'positions'|'classifications'>; groups: InventoryGroupSummary[] };
  positions: PositionLifecycleEvidenceResult[];
};

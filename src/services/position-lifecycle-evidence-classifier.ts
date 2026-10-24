import type { InventoryEvidenceReference, LifecycleInventoryReasonCode, PositionLifecycleEvidenceResult, PositionLifecycleEvidenceSource } from './position-lifecycle-evidence-inventory.types.js';

const active = (status: string) => status === 'open' || status === 'closing';
const canonical = (value: string) => value.trim().toUpperCase();

export function classifyPositionLifecycleEvidence(source: PositionLifecycleEvidenceSource): PositionLifecycleEvidenceResult {
  const reasons = new Set<LifecycleInventoryReasonCode>();
  const evidence: InventoryEvidenceReference[] = [{ kind: 'TrackedPosition', id: String(source.identity.trackedPositionId), role: 'SUPPORTING' }];
  const contradict = (code: LifecycleInventoryReasonCode, kind?: string, id?: string) => {
    reasons.add(code);
    if (kind && id) evidence.push({ kind, id, role: 'CONTRADICTING' });
  };
  if (source.identity.tradingAccountId === null) reasons.add('POSITION_ACCOUNT_MISSING');
  if (source.creationAuthority === null) reasons.add('CREATION_AUTHORITY_HISTORICAL_NULL');
  if (source.identity.accountBroker && canonical(source.identity.accountBroker) !== canonical(source.identity.positionBroker)) contradict('BROKER_MISMATCH');
  if (canonical(source.identity.securitySymbol) !== canonical(source.identity.positionSymbol)) contradict('SECURITY_SYMBOL_MISMATCH');

  const intents = source.intents.filter((intent) => intent.side.toLowerCase() === 'buy');
  if (source.intents.some((intent) => intent.side.toLowerCase() !== 'buy')) contradict('ENTRY_INTENT_NOT_BUY');
  if (intents.length === 0) reasons.add('ORDER_INTENT_LINK_MISSING');
  if (intents.length > 1) reasons.add('MULTIPLE_ENTRY_INTENTS_UNRECONCILED');

  let structural = intents.length === 1;
  let execution = intents.length === 1;
  const intent = intents[0];
  if (intent) {
    evidence.push({ kind: 'OrderIntent', id: String(intent.id), role: 'SUPPORTING' });
    if (intent.tradingAccountId !== source.identity.tradingAccountId || (intent.trackedPositionId !== null && intent.trackedPositionId !== source.identity.trackedPositionId)) contradict('ACCOUNT_IDENTITY_MISMATCH', 'OrderIntent', String(intent.id));
    if (intent.trackedPositionId === null) { reasons.add('HEURISTIC_OR_REPAIR_LINK_NOT_PROOF'); structural = false; }
    if (intent.subscriptionId === null) { reasons.add('FROZEN_SUBSCRIPTION_MISSING'); structural = false; }
    if (intent.tradingAccountSubscriptionId === null) { reasons.add('FROZEN_ASSIGNMENT_MISSING'); structural = false; }
    const attrs = source.attribution.filter((row) => row.subscriptionId === intent.subscriptionId);
    const attr = attrs.find((row) => row.assignmentId === intent.tradingAccountSubscriptionId);
    if (!attr || attr.securityId !== source.identity.securityId || attr.assignmentAccountId !== source.identity.tradingAccountId || attr.assignmentSubscriptionId !== intent.subscriptionId) {
      contradict('ATTRIBUTION_IDENTITY_CONFLICT'); structural = false;
    }
    if (source.currentState.subscriptionId !== null && source.currentState.subscriptionId !== intent.subscriptionId) contradict('ATTRIBUTION_IDENTITY_CONFLICT');
    if (source.currentState.tradingAccountSubscriptionId !== null && source.currentState.tradingAccountSubscriptionId !== intent.tradingAccountSubscriptionId) contradict('ATTRIBUTION_IDENTITY_CONFLICT');

    if (intent.brokerOrders.length === 0) { reasons.add('BROKER_ORDER_LINK_MISSING'); structural = false; }
    for (const order of intent.brokerOrders) {
      evidence.push({ kind: 'BrokerOrder', id: String(order.id), role: 'SUPPORTING' });
      if (order.tradingAccountId !== source.identity.tradingAccountId || (order.trackedPositionId !== null && order.trackedPositionId !== source.identity.trackedPositionId) || canonical(order.broker) !== canonical(source.identity.positionBroker)) contradict('BROKER_ORDER_IDENTITY_CONFLICT', 'BrokerOrder', String(order.id));
      if (order.trackedPositionId === null) { reasons.add('HEURISTIC_OR_REPAIR_LINK_NOT_PROOF'); structural = false; }
      if (!order.clientOrderIdMatchesIntent) contradict('CLIENT_ORDER_ID_MISMATCH', 'BrokerOrder', String(order.id));
    }
    const duplicateFills = intent.fills.filter((fill) => fill.activityIdDuplicateCount > 1);
    if (duplicateFills.length) {
      reasons.add('DUPLICATE_BROKER_ACTIVITY_IDENTITY'); structural = false; execution = false;
      duplicateFills.forEach((fill) => evidence.push({ kind: 'BrokerActivity', id: String(fill.id), role: 'CONTRADICTING' }));
    }
    if (intent.fills.length === 0) { reasons.add('CONFIRMED_ENTRY_FILL_MISSING'); structural = false; execution = false; }
    let executed = 0;
    for (const fill of intent.fills) {
      evidence.push({ kind: 'BrokerActivity', id: String(fill.id), role: 'SUPPORTING' });
      if (fill.tradingAccountId !== source.identity.tradingAccountId || (fill.trackedPositionId !== null && fill.trackedPositionId !== source.identity.trackedPositionId)) contradict('ACCOUNT_IDENTITY_MISMATCH', 'BrokerActivity', String(fill.id));
      if (fill.trackedPositionId === null) { reasons.add('HEURISTIC_OR_REPAIR_LINK_NOT_PROOF'); structural = false; }
      if (!fill.orderIdMatchesBrokerOrder) contradict('FILL_ORDER_ID_MISMATCH', 'BrokerActivity', String(fill.id));
      if (fill.qty === null || !Number.isFinite(fill.qty) || fill.qty <= 0) reasons.add('EXECUTED_QUANTITY_AMBIGUOUS'); else executed += Math.abs(fill.qty);
    }
    if (intent.qty === null || reasons.has('EXECUTED_QUANTITY_AMBIGUOUS')) execution = false;
    else if (Math.abs(executed - Math.abs(intent.qty)) > 0.000001) { reasons.add('ENTRY_FILL_PARTIAL_ONLY'); execution = false; }
    const dispatchIds = [...intent.dispatch.consumptionIds, ...intent.dispatch.unenforcedDispatchIds];
    if (dispatchIds.length !== 1) { reasons.add(dispatchIds.length ? 'DISPATCH_EVIDENCE_CONFLICT' : 'DISPATCH_EVIDENCE_MISSING'); execution = false; }
    if (!intent.dispatch.clientIdentityConsistent) { contradict('DISPATCH_EVIDENCE_CONFLICT'); execution = false; }
    if (intent.dispatch.adapterMarkerEventIds.length !== 1) { reasons.add('ADAPTER_INVOCATION_EVIDENCE_MISSING'); execution = false; }
    dispatchIds.forEach((id) => evidence.push({ kind: 'BrokerDispatch', id: String(id), role: 'SUPPORTING' }));
    intent.dispatch.adapterMarkerEventIds.forEach((id) => evidence.push({ kind: 'EntryExposureClaimEvent', id: String(id), role: 'SUPPORTING' }));
  }

  if (!source.claim) reasons.add('ENTRY_CLAIM_MISSING');
  else {
    evidence.push({ kind: 'EntryExposureClaim', id: String(source.claim.id), role: 'CORROBORATING' });
    if (source.claim.status === 'UNRESOLVED') reasons.add('ENTRY_CLAIM_UNRESOLVED');
    if (source.claim.tradingAccountId !== source.identity.tradingAccountId || source.claim.securityId !== source.identity.securityId || (source.claim.trackedPositionId !== null && source.claim.trackedPositionId !== source.identity.trackedPositionId)) contradict('ENTRY_CLAIM_IDENTITY_CONFLICT');
  }
  if (!source.provenance.chainValid) contradict('PROVENANCE_CHAIN_INVALID');
  if (source.provenance.decisionIds.length === 0) reasons.add('NO_RECORDED_PROVENANCE_DECISION');
  source.provenance.decisionIds.forEach((id) => evidence.push({ kind: 'PositionLifecycleProvenanceDecision', id: String(id), role: 'CORROBORATING' }));
  const verifiedExternal = source.provenance.origin === 'BROKER_EXTERNAL' && source.provenance.ownership === 'NOT_LOCALLY_OWNED' && source.provenance.trust === 'VERIFIED';
  if (source.provenance.origin === 'BROKER_EXTERNAL' && !verifiedExternal) reasons.add('RECORDED_EXTERNAL_PROVENANCE_UNVERIFIED');

  const contradictionCodes: LifecycleInventoryReasonCode[] = ['ACCOUNT_IDENTITY_MISMATCH','BROKER_MISMATCH','SECURITY_SYMBOL_MISMATCH','ENTRY_INTENT_NOT_BUY','BROKER_ORDER_IDENTITY_CONFLICT','FILL_ORDER_ID_MISMATCH','CLIENT_ORDER_ID_MISMATCH','DISPATCH_EVIDENCE_CONFLICT','ATTRIBUTION_IDENTITY_CONFLICT','ENTRY_CLAIM_IDENTITY_CONFLICT','PROVENANCE_CHAIN_INVALID'];
  let contradictory = contradictionCodes.some((code) => reasons.has(code));
  const complete = structural && execution && intents.length === 1 && !contradictory;
  if (complete && source.provenance.origin && source.provenance.origin !== 'LOCAL_ORDER_CHAIN') { reasons.add('RECORDED_PROVENANCE_DISAGREES'); contradictory = true; }
  if (verifiedExternal && (complete || intents.length > 0)) { reasons.add('RECORDED_PROVENANCE_DISAGREES'); contradictory = true; }
  if (complete) reasons.add('LOCAL_ENTRY_CHAIN_COMPLETE');
  if (verifiedExternal) reasons.add('INDEPENDENT_EXTERNAL_ORIGIN_VERIFIED');
  if (source.exitState && active(source.currentState.status)) reasons.add('OPEN_POSITION_HAS_EXIT_STATE');
  const legacyReview = Boolean(source.exitState && active(source.currentState.status) && !complete && !source.provenance.legacyExitContinuityAuthorized);
  if (legacyReview) reasons.add('LEGACY_EXIT_CONTINUITY_REVIEW_REQUIRED');
  if (source.provenance.legacyExitContinuityAuthorized) reasons.add('LEGACY_EXIT_CONTINUITY_REVIEWED');

  const shadowClassification = contradictory ? 'CONTRADICTORY_EVIDENCE' : complete ? 'COMPLETE_LOCAL_ORDER_CHAIN' : verifiedExternal ? 'POSITIVE_EXTERNAL_ORIGIN' : 'UNKNOWN_INCOMPLETE_LINEAGE';
  return { ...source, shadowClassification, confidence: contradictory ? 'CONTRADICTORY' : complete ? 'DETERMINISTIC' : verifiedExternal ? 'VERIFIED' : 'INSUFFICIENT', reasonCodes: [...reasons].sort(), evidence: evidence.sort((a,b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)), readiness: { structurallyCompleteLocalLineage: structural, independentlySupportedLocalExecution: execution, legacyExitContinuityReviewRequired: legacyReview } };
}

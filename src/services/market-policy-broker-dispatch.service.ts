import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type MarketPolicyBrokerDispatchOutcome,
  type PrismaClient,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import {
  resolveLockedAssignmentMarketPolicyEnforcement,
  type LockedMarketPolicyEnforcementResolution,
  type MarketPolicyEnforcementDisposition,
} from './assignment-market-policy-enforcement-authorization.service.js';
import { lockMarketPolicyEnforcementRollout } from './market-policy-enforcement-rollout.service.js';
import {
  compositionEvidence,
  evaluateMarketPolicyRevisionOnCurrentComposition,
  type MarketPolicyEvaluation,
  type MarketPolicyEvaluator,
  type MarketPolicyEvaluatorRule,
} from './market-policy-entry-admission.service.js';
import { evaluateStrategyMarketEligibility, STRATEGY_MARKET_ELIGIBILITY_VERSION } from './strategy-market-eligibility.service.js';
import { createSystemEvent } from './system-event.service.js';

// Phase 3C.3 authoritative broker-time market-policy enforcement. It runs only after the stable
// client-order-ID lookup confirmed that no broker order exists, and before any new Alpaca BUY POST.
//
// - An intent with a frozen 3C.2 obligation is revalidated on every new dispatch opportunity,
//   whatever the runtime rollout state: the exact frozen authorization must still be AUTHORIZED,
//   latest and fingerprint-equal, its generation and revision ACTIVE, and a fresh synchronous
//   evaluation of the frozen revision on the current committed composition must be ALLOWED.
// - An intent without an obligation keeps existing behavior, except that under the active rollout
//   an assignment whose authorization now requires enforcement quarantines it (never a fresh POST).
//   The disposition is re-decided in a final serialized authorization immediately before the
//   adapter (MarketPolicyBrokerUnenforcedDispatch); a grant or activation that commits first
//   quarantines the entry.
// - LIVE accounts, SELL orders, protective exits, close-position and recovery never reach here.
//
// An ALLOWED decision is a bounded, single-use dispatch authorization. It is consumed in a separate
// short transaction immediately before the adapter call; that consumption is the linearization point.
// A consumption or un-enforced dispatch authorization is durable evidence that a POST may have
// started, never proof of broker receipt: it permanently prohibits another POST for that intent.
export const MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION = 'MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1' as const;
export const MARKET_POLICY_BROKER_DISPATCH_WINDOW_MS = 30_000;
const PREPARATION_TRANSACTION = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000, maxWait: 10_000 } as const;
const NON_ENFORCED_DISPOSITIONS = new Set<MarketPolicyEnforcementDisposition>(['NEVER_AUTHORIZED', 'OWNER_REVOKED', 'OWNER_OPTED_OUT', 'NOT_APPLICABLE_LIVE']);
const UNENFORCED_DISPATCH_BASES = new Set<string>(['NEVER_AUTHORIZED', 'OWNER_REVOKED', 'OWNER_OPTED_OUT']);

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export type EntryBrokerDispatchRequest = {
  orderIntentId: number;
  tradingAccountId: number;
  symbol: string;
  clientOrderId: string;
};

export type BrokerDispatchDependencies = { db?: PrismaClient; evaluator?: MarketPolicyEvaluator };

/**
 * Raised when the broker-time guard refuses a new POST. Nothing was dispatched: the stable-ID lookup
 * confirmed absence and the adapter was never invoked, so this is a definite non-send.
 */
export class MarketPolicyBrokerDispatchRefusedError extends Error {
  readonly deliveryClassification = 'DEFINITELY_NOT_SENT' as const;
  readonly outcome: MarketPolicyBrokerDispatchOutcome;
  readonly reasonCode: string;
  readonly decisionId: number | null;
  readonly technical: boolean;

  constructor(args: { outcome: MarketPolicyBrokerDispatchOutcome; reasonCode: string; decisionId: number | null; diagnostic?: string }) {
    super(`Broker-time market policy refused the entry dispatch (${args.outcome}: ${args.reasonCode})${args.diagnostic ? `: ${args.diagnostic}` : ''}.`);
    this.name = 'MarketPolicyBrokerDispatchRefusedError';
    this.outcome = args.outcome;
    this.reasonCode = args.reasonCode;
    this.decisionId = args.decisionId;
    this.technical = args.outcome === 'TECHNICAL_FAILURE';
  }

  get code() {
    return `MARKET_POLICY_BROKER_TIME_${this.outcome}`;
  }

  get blockReason() {
    return `MARKET_POLICY_BROKER_TIME:${this.outcome}:DEFINITELY_NOT_SENT:${this.reasonCode}${this.decisionId ? `:decision=${this.decisionId}` : ''}`;
  }

  get claimReleaseReason() {
    return `BROKER_TIME_MARKET_POLICY_${this.outcome}_NOT_SENT`;
  }
}

export function getMarketPolicyBrokerDispatchRefusal(error: unknown) {
  return error instanceof MarketPolicyBrokerDispatchRefusedError ? error : null;
}

/**
 * The dispatch record (consumption or un-enforced dispatch authorization) committed but its
 * acknowledgement was lost, so this attempt never invoked the adapter. The committed record still
 * prohibits any further POST for the intent; its claim is routed to evidence-based recovery.
 */
export class EntryDispatchRecordedNotSentError extends Error {
  readonly deliveryClassification = 'NOT_SENT_DISPATCH_RECORD_ACK_LOST' as const;
  readonly code = 'ENTRY_DISPATCH_RECORD_EXISTS' as const;

  constructor(readonly record: 'CONSUMPTION' | 'UNENFORCED_DISPATCH', readonly recordId: number) {
    super(`A ${record} for this entry already committed; no further POST is permitted and this attempt did not invoke the adapter.`);
    this.name = 'EntryDispatchRecordedNotSentError';
  }

  get blockReason() {
    return `ENTRY_DISPATCH_RECORDED_NOT_SENT:${this.record}:${this.recordId}`;
  }
}

export function getEntryDispatchRecordedNotSent(error: unknown) {
  return error instanceof EntryDispatchRecordedNotSentError ? error : null;
}

export type PreparedEntryBrokerDispatch = {
  enforcement: 'FROZEN_OBLIGATION' | 'UNOBLIGATED_FINAL_AUTHORIZATION' | 'NOT_APPLICABLE';
  applicability: string;
  decisionId: number | null;
  dispatchExpiresAt: Date | null;
  /**
   * The final serialized authorization, called as the last step before the adapter. A frozen
   * obligation consumes its ALLOWED decision; an un-obligated PAPER entry records its un-enforced
   * dispatch authorization or is quarantined. Resolves only when a new POST is authorized; otherwise
   * throws MarketPolicyBrokerDispatchRefusedError (nothing sent) or, when the record committed but
   * its acknowledgement was lost, EntryDispatchRecordedNotSentError (nothing sent by this attempt).
   */
  authorizeDispatch: (brokerPostOpportunityId: number | null) => Promise<void>;
};

class BrokerDispatchTechnicalError extends Error {
  constructor(readonly stage: string, readonly underlying: unknown) {
    super(`${stage}: ${underlying instanceof Error ? underlying.message : String(underlying)}`);
    this.name = 'BrokerDispatchTechnicalError';
  }
}

type DispatchIntent = {
  id: number;
  tradingAccountId: number | null;
  tradingAccountSubscriptionId: number | null;
  clientOrderId: string | null;
  environment: string | null;
  obligationId: number | null;
};

type DecisionResult = {
  decisionId: number;
  outcome: MarketPolicyBrokerDispatchOutcome;
  reasonCode: string;
  dispatchExpiresAt: Date | null;
  clientOrderId: string;
};

const notApplicable = (applicability: string): PreparedEntryBrokerDispatch => ({
  enforcement: 'NOT_APPLICABLE', applicability, decisionId: null, dispatchExpiresAt: null, authorizeDispatch: async () => undefined,
});

async function loadDispatchIntent(db: PrismaClient, orderIntentId: number): Promise<DispatchIntent> {
  const intent = await db.orderIntent.findUnique({
    where: { id: orderIntentId },
    select: {
      id: true, tradingAccountId: true, tradingAccountSubscriptionId: true, clientOrderId: true,
      tradingAccount: { select: { environment: true } }, marketPolicyEnforcementObligation: { select: { id: true } },
    },
  });
  if (!intent) throw new Error('ORDER_INTENT_NOT_FOUND');
  return {
    id: intent.id, tradingAccountId: intent.tradingAccountId, tradingAccountSubscriptionId: intent.tradingAccountSubscriptionId,
    clientOrderId: intent.clientOrderId, environment: intent.tradingAccount?.environment ?? null,
    obligationId: intent.marketPolicyEnforcementObligation?.id ?? null,
  };
}

async function decisionClock(tx: Prisma.TransactionClient) {
  const [clock] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`;
  return clock!.at;
}

async function nextDispatchSequence(db: Prisma.TransactionClient | PrismaClient, orderIntentId: number) {
  const aggregate = await db.marketPolicyBrokerDispatchDecision.aggregate({ where: { orderIntentId }, _max: { dispatchSequence: true } });
  return (aggregate._max.dispatchSequence ?? 0) + 1;
}

type AuthorizationEvidenceSource = Pick<NonNullable<LockedMarketPolicyEnforcementResolution['authorization']>, 'id' | 'status' | 'authorityVersion' | 'authorizationFingerprint' | 'enrollmentGenerationId' | 'policyRevisionId' | 'invalidationReasonCode'>;

function authorizationEvidence(authorization: AuthorizationEvidenceSource | null) {
  return authorization ? {
    id: authorization.id, status: authorization.status, authorityVersion: authorization.authorityVersion,
    authorizationFingerprint: authorization.authorizationFingerprint, enrollmentGenerationId: authorization.enrollmentGenerationId,
    policyRevisionId: authorization.policyRevisionId, invalidationReasonCode: authorization.invalidationReasonCode,
  } : null;
}

/**
 * Frozen-obligation preparation: one short READ COMMITTED transaction, committed before any broker
 * I/O. Lock order matches pre-intent admission: rollout FOR SHARE, TradingAccount, assignment,
 * Subscription, Security (KEY SHARE), latest authorization FOR SHARE, then the entry-exposure
 * advisory lock. Revocation and every invalidation path therefore serialize against it.
 */
async function prepareObligatedDecision(db: PrismaClient, request: EntryBrokerDispatchRequest, obligationId: number, evaluator: MarketPolicyEvaluator): Promise<DecisionResult> {
  return db.$transaction(async tx => {
    const rollout = await lockMarketPolicyEnforcementRollout(tx);
    const obligation = await tx.orderIntentMarketPolicyEnforcementObligation.findUnique({ where: { id: obligationId } });
    if (!obligation || obligation.orderIntentId !== request.orderIntentId) throw new BrokerDispatchTechnicalError('OBLIGATION_LOAD', new Error('Frozen obligation does not belong to the OrderIntent.'));
    let resolution: LockedMarketPolicyEnforcementResolution;
    try {
      resolution = await resolveLockedAssignmentMarketPolicyEnforcement(tx, obligation.accountSubscriptionId);
    } catch (error) {
      throw new BrokerDispatchTechnicalError('AUTHORIZATION_RESOLUTION', error);
    }
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${obligation.tradingAccountId}:${obligation.securityId}`}, 0))::text`;

    const intent = await tx.orderIntent.findUniqueOrThrow({
      where: { id: request.orderIntentId },
      select: {
        id: true, tradingAccountId: true, tradingAccountSubscriptionId: true, clientOrderId: true, symbol: true, side: true, status: true,
        entryExposureClaim: { select: { id: true, status: true, releasedAt: true, tradingAccountId: true, securityId: true } },
        marketPolicyBrokerDispatchConsumption: { select: { id: true } },
      },
    });
    // A started dispatch is recovered through the stable client order ID, never repeated.
    if (intent.marketPolicyBrokerDispatchConsumption) throw new BrokerDispatchTechnicalError('PRIOR_DISPATCH_STARTED', new Error('A dispatch for this OrderIntent already started.'));
    const frozenAuthorization = await tx.assignmentMarketPolicyEnforcementAuthorization.findUnique({ where: { id: obligation.authorizationId } });
    const revision = await tx.strategyMarketPolicyRevision.findUnique({
      where: { id: obligation.policyRevisionId },
      select: { id: true, status: true, policy: { select: { strategyId: true } }, dimensionRules: { select: { dimension: true, algorithmVersion: true, requirement: true, allowedStates: { select: { state: true } } } } },
    });
    const generation = await tx.assignmentMarketPolicyEnrollmentGeneration.findUnique({ where: { id: obligation.enrollmentGenerationId }, select: { id: true, status: true } });
    const latest = resolution.authorization;
    const claim = intent.entryExposureClaim;
    const symbol = request.symbol.trim().toUpperCase();

    const identityMismatches = [
      ...(request.tradingAccountId !== obligation.tradingAccountId || intent.tradingAccountId !== obligation.tradingAccountId ? ['ACCOUNT'] : []),
      ...(intent.tradingAccountSubscriptionId !== obligation.accountSubscriptionId ? ['ASSIGNMENT'] : []),
      ...(symbol !== obligation.securitySymbol || intent.symbol.trim().toUpperCase() !== obligation.securitySymbol ? ['SYMBOL'] : []),
      ...(intent.side.trim().toLowerCase() !== 'buy' ? ['SIDE'] : []),
      ...(intent.clientOrderId !== request.clientOrderId ? ['CLIENT_ORDER_ID'] : []),
      ...(intent.status !== 'submitting' ? ['INTENT_NOT_SUBMITTING'] : []),
      ...(!claim || claim.releasedAt || claim.status !== 'ENTRY_SUBMITTING' || claim.tradingAccountId !== obligation.tradingAccountId || claim.securityId !== obligation.securityId ? ['ENTRY_EXPOSURE_CLAIM'] : []),
    ];
    const bindingMismatches = [
      ...(resolution.identity.environment !== 'PAPER' ? ['ENVIRONMENT'] : []),
      ...(resolution.identity.tradingAccountId !== obligation.tradingAccountId ? ['ASSIGNMENT_ACCOUNT'] : []),
      ...(resolution.identity.subscriptionId !== obligation.subscriptionId ? ['ASSIGNMENT_SUBSCRIPTION'] : []),
      ...(resolution.identity.securityId !== obligation.securityId || resolution.identity.securitySymbol !== obligation.securitySymbol ? ['ASSIGNMENT_SECURITY'] : []),
      ...(resolution.identity.strategyId !== obligation.strategyId ? ['ASSIGNMENT_STRATEGY'] : []),
    ];

    let outcome: MarketPolicyBrokerDispatchOutcome | null = null;
    let reasonCode = '';
    if (identityMismatches.length) { outcome = 'ENTRY_IDENTITY_MISMATCH'; reasonCode = `ENTRY_IDENTITY_MISMATCH_${identityMismatches.join('_')}`; }
    else if (!revision || revision.status !== 'ACTIVE' || revision.policy.strategyId !== obligation.strategyId) { outcome = 'POLICY_REVISION_SUPERSEDED'; reasonCode = `FROZEN_POLICY_REVISION_${revision?.status ?? 'MISSING'}`; }
    else if (!frozenAuthorization) { outcome = 'AUTHORIZATION_INEFFECTIVE'; reasonCode = 'FROZEN_AUTHORIZATION_MISSING'; }
    else if (frozenAuthorization.status === 'REVOKED') { outcome = 'AUTHORIZATION_REVOKED'; reasonCode = 'FROZEN_AUTHORIZATION_REVOKED'; }
    else if (frozenAuthorization.status === 'INVALIDATED') { outcome = 'AUTHORIZATION_INVALIDATED'; reasonCode = `FROZEN_AUTHORIZATION_INVALIDATED_${frozenAuthorization.invalidationReasonCode ?? 'UNKNOWN'}`; }
    else if (!latest || latest.id !== frozenAuthorization.id) { outcome = 'AUTHORIZATION_SUPERSEDED'; reasonCode = 'NEWER_AUTHORIZATION_EXISTS'; }
    else if (frozenAuthorization.authorizationFingerprint !== obligation.authorizationFingerprint || frozenAuthorization.authorityVersion !== obligation.authorityVersion) { outcome = 'AUTHORIZATION_INEFFECTIVE'; reasonCode = 'FROZEN_AUTHORIZATION_FINGERPRINT_MISMATCH'; }
    else if (!generation || generation.status !== 'ACTIVE') { outcome = 'ENROLLMENT_GENERATION_INACTIVE'; reasonCode = `FROZEN_ENROLLMENT_GENERATION_${generation?.status ?? 'MISSING'}`; }
    else if (resolution.disposition !== 'ENFORCED') { outcome = 'AUTHORIZATION_INEFFECTIVE'; reasonCode = resolution.reasons[0] ?? `DISPOSITION_${resolution.disposition}`; }
    else if (bindingMismatches.length) { outcome = 'ENTRY_IDENTITY_MISMATCH'; reasonCode = `ASSIGNMENT_BINDING_CHANGED_${bindingMismatches.join('_')}`; }

    const dispatchSequence = await nextDispatchSequence(tx, request.orderIntentId);
    const evaluatedAt = await decisionClock(tx);
    let evaluation: MarketPolicyEvaluation | null = null;
    if (!outcome) {
      try {
        // The frozen revision, never the Strategy's current one: no silent revision substitution.
        evaluation = await evaluateMarketPolicyRevisionOnCurrentComposition(tx, revision!.dimensionRules as MarketPolicyEvaluatorRule[], evaluatedAt, evaluator);
      } catch (error) {
        throw new BrokerDispatchTechnicalError('MARKET_EVALUATION', error);
      }
      outcome = evaluation.outcome;
      reasonCode = evaluation.reasonCode;
    }
    const allowed = outcome === 'ALLOWED';
    const validUntil = allowed ? evaluation!.validUntil! : null;
    const dispatchExpiresAt = validUntil ? new Date(Math.min(validUntil.getTime(), evaluatedAt.getTime() + MARKET_POLICY_BROKER_DISPATCH_WINDOW_MS)) : null;
    const composition = evaluation?.composition ?? null;

    try {
      const decision = await tx.marketPolicyBrokerDispatchDecision.create({
        data: {
          decisionKey: randomUUID(), decisionVersion: MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION, orderIntentId: request.orderIntentId, obligationId: obligation.id,
          dispatchSequence, clientOrderId: intent.clientOrderId ?? request.clientOrderId, environment: 'PAPER',
          tradingAccountId: obligation.tradingAccountId, accountSubscriptionId: obligation.accountSubscriptionId, subscriptionId: obligation.subscriptionId,
          securityId: obligation.securityId, securitySymbol: obligation.securitySymbol, strategyId: obligation.strategyId, policyRevisionId: obligation.policyRevisionId,
          enrollmentGenerationId: obligation.enrollmentGenerationId, authorizationId: obligation.authorizationId, authorizationFingerprint: obligation.authorizationFingerprint,
          authorityVersion: obligation.authorityVersion, authorizationStatus: frozenAuthorization?.status ?? null,
          rolloutEnabled: rollout.enabled, rolloutVersion: rollout.version,
          evaluatorVersion: evaluation ? STRATEGY_MARKET_ELIGIBILITY_VERSION : null, evaluatedAt, validUntil, dispatchExpiresAt,
          marketRegimeAssessmentId: composition?.id ?? null, compositionVersion: composition?.compositionVersion ?? null,
          compositionSourceSetFingerprint: composition?.sourceSetFingerprint ?? null, compositionEvidenceHealth: composition?.evidenceHealth ?? null,
          outcome, reasonCode, dispatchDisposition: allowed ? 'DISPATCH_AUTHORIZED' : 'DEFINITELY_NOT_SENT',
          evidenceJson: json({
            decisionVersion: MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION,
            semantics: allowed ? 'SINGLE_USE_BOUNDED_DISPATCH_AUTHORIZATION' : 'DEFINITE_NON_SEND',
            obligation: { id: obligation.id, admissionAttemptId: obligation.admissionAttemptId, evaluatedAt: obligation.evaluatedAt, validUntil: obligation.validUntil, rolloutVersion: obligation.rolloutVersion },
            frozenAuthorization: authorizationEvidence(frozenAuthorization), latestAuthorization: authorizationEvidence(latest),
            disposition: resolution.disposition, dispositionReasons: resolution.reasons,
            generation: generation ? { id: generation.id, status: generation.status } : null,
            revision: revision ? { id: revision.id, status: revision.status } : null,
            identityMismatches, bindingMismatches,
            rollout: { enabled: rollout.enabled, version: rollout.version, authority: 'NOT_CONSULTED_FOR_FROZEN_OBLIGATIONS' },
            composition: compositionEvidence(composition),
            evaluation: evaluation ? { evaluatorVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION, outcome: evaluation.outcome, reasonCode: evaluation.reasonCode, validUntil: evaluation.validUntil } : null,
            dispatchWindowMs: MARKET_POLICY_BROKER_DISPATCH_WINDOW_MS,
            boundaries: { liveAuthority: 'NONE', providerCalls: 'NONE', shadowDecisionReused: false, admissionDecisionReused: false },
          }),
          ...(evaluation && composition ? { gates: { create: evaluation.gates } } : {}),
        },
      });
      return { decisionId: decision.id, outcome, reasonCode, dispatchExpiresAt, clientOrderId: decision.clientOrderId };
    } catch (error) {
      throw new BrokerDispatchTechnicalError('DECISION_PERSISTENCE', error);
    }
  }, PREPARATION_TRANSACTION);
}

type LockedRollout = Awaited<ReturnType<typeof lockMarketPolicyEnforcementRollout>>;

function lockEntryExposure(tx: Prisma.TransactionClient, tradingAccountId: number, securityId: number) {
  return tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${tradingAccountId}:${securityId}`}, 0))::text`;
}

async function recordQuarantineDecision(
  tx: Prisma.TransactionClient,
  request: EntryBrokerDispatchRequest,
  intent: DispatchIntent,
  rollout: LockedRollout,
  resolution: LockedMarketPolicyEnforcementResolution,
  stage: 'PREPARATION' | 'FINAL_DISPATCH_AUTHORIZATION',
): Promise<DecisionResult> {
  const authorization = resolution.authorization!;
  const dispatchSequence = await nextDispatchSequence(tx, request.orderIntentId);
  const evaluatedAt = await decisionClock(tx);
  const reasonCode = `UNOBLIGATED_ENTRY_UNDER_${resolution.disposition}${stage === 'FINAL_DISPATCH_AUTHORIZATION' ? '_AT_FINAL_AUTHORIZATION' : ''}`;
  try {
    const decision = await tx.marketPolicyBrokerDispatchDecision.create({
      data: {
        decisionKey: randomUUID(), decisionVersion: MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION, orderIntentId: request.orderIntentId, obligationId: null,
        dispatchSequence, clientOrderId: intent.clientOrderId ?? request.clientOrderId, environment: 'PAPER',
        tradingAccountId: intent.tradingAccountId!, accountSubscriptionId: intent.tradingAccountSubscriptionId!, subscriptionId: resolution.identity.subscriptionId,
        securityId: resolution.identity.securityId, securitySymbol: resolution.identity.securitySymbol, strategyId: resolution.identity.strategyId,
        policyRevisionId: authorization.policyRevisionId, enrollmentGenerationId: authorization.enrollmentGenerationId, authorizationId: authorization.id,
        authorizationFingerprint: authorization.authorizationFingerprint, authorityVersion: authorization.authorityVersion, authorizationStatus: authorization.status,
        rolloutEnabled: rollout.enabled, rolloutVersion: rollout.version, evaluatedAt,
        outcome: 'LEGACY_UNOBLIGATED_QUARANTINED', reasonCode, dispatchDisposition: 'DEFINITELY_NOT_SENT',
        evidenceJson: json({
          decisionVersion: MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION, semantics: 'LEGACY_QUEUED_ENTRY_QUARANTINE; NO_ALLOWED_ADMISSION_INVENTED',
          stage, disposition: resolution.disposition, dispositionReasons: resolution.reasons, latestAuthorization: authorizationEvidence(authorization),
          identity: resolution.identity, rollout: { enabled: rollout.enabled, version: rollout.version },
          boundaries: { liveAuthority: 'NONE', providerCalls: 'NONE' },
        }),
      },
    });
    return { decisionId: decision.id, outcome: decision.outcome, reasonCode, dispatchExpiresAt: null, clientOrderId: decision.clientOrderId };
  } catch (error) {
    throw new BrokerDispatchTechnicalError('DECISION_PERSISTENCE', error);
  }
}

/**
 * Un-obligated PAPER entries: existing behavior unless the active rollout and the assignment's
 * current authorization require enforcement, in which case the queued intent is quarantined (it was
 * never gated, so it can never become a fresh POST, and no ALLOWED admission is invented for it).
 * This early read only avoids opportunity capture for an entry that is already quarantinable; the
 * authoritative decision is the final dispatch authorization below.
 */
async function prepareUnobligatedDecision(db: PrismaClient, request: EntryBrokerDispatchRequest, intent: DispatchIntent): Promise<DecisionResult | { applicability: string }> {
  return db.$transaction(async tx => {
    const rollout = await lockMarketPolicyEnforcementRollout(tx);
    if (!rollout.enabled) return { applicability: 'RUNTIME_INACTIVE' };
    let resolution: LockedMarketPolicyEnforcementResolution;
    try {
      resolution = await resolveLockedAssignmentMarketPolicyEnforcement(tx, intent.tradingAccountSubscriptionId!);
    } catch (error) {
      throw new BrokerDispatchTechnicalError('AUTHORIZATION_RESOLUTION', error);
    }
    if (NON_ENFORCED_DISPOSITIONS.has(resolution.disposition)) return { applicability: resolution.disposition };
    await lockEntryExposure(tx, resolution.identity.tradingAccountId, resolution.identity.securityId);
    return recordQuarantineDecision(tx, request, intent, rollout, resolution, 'PREPARATION');
  }, PREPARATION_TRANSACTION);
}

type FinalUnobligatedAuthorization = { kind: 'AUTHORIZED'; id: number; basis: string } | { kind: 'QUARANTINED'; decision: DecisionResult };

/**
 * Hermes MEDIUM-1: the final serialized authorization of an un-obligated PAPER entry, after
 * compare-only opportunity capture and immediately before the adapter. One short READ COMMITTED
 * transaction in the established lock order (rollout FOR SHARE, account, assignment, Subscription,
 * Security, latest authorization FOR SHARE, entry-exposure advisory lock) re-decides the disposition
 * and revalidates the exact executable identity, and PostgreSQL re-checks both on insert. Its commit
 * is the linearization point: a grant, re-grant or activation committed before it quarantines the
 * entry; one committed after it cannot recall the in-flight POST. No transaction spans broker I/O.
 */
async function authorizeUnobligatedDispatchInTransaction(
  db: PrismaClient,
  request: EntryBrokerDispatchRequest,
  intent: DispatchIntent,
  brokerPostOpportunityId: number | null,
): Promise<FinalUnobligatedAuthorization> {
  return db.$transaction(async tx => {
    const rollout = await lockMarketPolicyEnforcementRollout(tx);
    const symbol = request.symbol.trim().toUpperCase();
    let resolution: LockedMarketPolicyEnforcementResolution | null = null;
    let security: { id: number; symbol: string } | undefined;
    if (intent.tradingAccountSubscriptionId !== null) {
      try {
        resolution = await resolveLockedAssignmentMarketPolicyEnforcement(tx, intent.tradingAccountSubscriptionId);
      } catch (error) {
        throw new BrokerDispatchTechnicalError('AUTHORIZATION_RESOLUTION', error);
      }
      security = { id: resolution.identity.securityId, symbol: resolution.identity.securitySymbol };
    } else {
      [security] = await tx.$queryRaw<Array<{ id: number; symbol: string }>>`SELECT id, symbol FROM "Security" WHERE symbol = ${symbol} FOR KEY SHARE`;
    }
    if (!security) throw new BrokerDispatchTechnicalError('FINAL_AUTHORIZATION_IDENTITY', new Error('SECURITY_NOT_FOUND'));
    await lockEntryExposure(tx, request.tradingAccountId, security.id);

    const current = await tx.orderIntent.findUniqueOrThrow({
      where: { id: request.orderIntentId },
      select: {
        tradingAccountId: true, tradingAccountSubscriptionId: true, clientOrderId: true, symbol: true, side: true, status: true,
        tradingAccount: { select: { environment: true } },
        entryExposureClaim: { select: { status: true, releasedAt: true, tradingAccountId: true, securityId: true } },
        marketPolicyEnforcementObligation: { select: { id: true } },
        marketPolicyBrokerDispatchConsumption: { select: { id: true } },
        marketPolicyBrokerUnenforcedDispatch: { select: { id: true } },
      },
    });
    const claim = current.entryExposureClaim;
    const mismatches = [
      ...(current.tradingAccount?.environment !== 'PAPER' || (resolution && resolution.identity.environment !== 'PAPER') ? ['ENVIRONMENT'] : []),
      ...(current.tradingAccountId !== request.tradingAccountId || (resolution && resolution.identity.tradingAccountId !== request.tradingAccountId) ? ['ACCOUNT'] : []),
      ...(current.tradingAccountSubscriptionId !== intent.tradingAccountSubscriptionId ? ['ASSIGNMENT'] : []),
      ...(current.symbol.trim().toUpperCase() !== symbol || security.symbol !== symbol ? ['SYMBOL'] : []),
      ...(current.side.trim().toLowerCase() !== 'buy' ? ['SIDE'] : []),
      ...(current.clientOrderId !== request.clientOrderId ? ['CLIENT_ORDER_ID'] : []),
      ...(current.status !== 'submitting' ? ['INTENT_NOT_SUBMITTING'] : []),
      ...(current.marketPolicyEnforcementObligation ? ['OBLIGATION_PRESENT'] : []),
      ...(current.marketPolicyBrokerDispatchConsumption || current.marketPolicyBrokerUnenforcedDispatch ? ['PRIOR_DISPATCH_RECORD'] : []),
      ...(!claim || claim.releasedAt || claim.status !== 'ENTRY_SUBMITTING' || claim.tradingAccountId !== request.tradingAccountId || claim.securityId !== security.id ? ['ENTRY_EXPOSURE_CLAIM'] : []),
    ];
    if (mismatches.length) throw new BrokerDispatchTechnicalError('FINAL_AUTHORIZATION_REVALIDATION', new Error(`ENTRY_NOT_EXECUTABLE_${mismatches.join('_')}`));

    // A grant, re-grant or activation committed before this point requires enforcement now.
    if (rollout.enabled && resolution && !NON_ENFORCED_DISPOSITIONS.has(resolution.disposition)) {
      return { kind: 'QUARANTINED' as const, decision: await recordQuarantineDecision(tx, request, intent, rollout, resolution, 'FINAL_DISPATCH_AUTHORIZATION') };
    }
    const basis = !rollout.enabled ? 'RUNTIME_INACTIVE' : resolution ? resolution.disposition : 'NO_ASSIGNMENT';
    if (rollout.enabled && resolution && !UNENFORCED_DISPATCH_BASES.has(basis)) {
      throw new BrokerDispatchTechnicalError('FINAL_AUTHORIZATION_DISPOSITION', new Error(`UNEXPECTED_DISPOSITION_${basis}`));
    }
    const latest = resolution?.authorization ?? null;
    try {
      const row = await tx.marketPolicyBrokerUnenforcedDispatch.create({
        data: {
          orderIntentId: request.orderIntentId, clientOrderId: request.clientOrderId, environment: 'PAPER',
          tradingAccountId: request.tradingAccountId, accountSubscriptionId: intent.tradingAccountSubscriptionId,
          securityId: security.id, securitySymbol: security.symbol, basis,
          latestAuthorizationId: latest?.id ?? null, latestAuthorizationStatus: latest?.status ?? null,
          rolloutEnabled: rollout.enabled, rolloutVersion: rollout.version, brokerPostOpportunityId,
          evidenceJson: json({
            semantics: 'FINAL_NON_ENFORCED_DISPATCH_AUTHORIZATION; DISPATCH_MAY_START_AFTER_COMMIT; NOT_PROOF_OF_BROKER_RECEIPT',
            disposition: resolution?.disposition ?? 'NO_ASSIGNMENT', dispositionReasons: resolution?.reasons ?? [],
            latestAuthorization: authorizationEvidence(latest), rollout: { enabled: rollout.enabled, version: rollout.version },
            residualRace: 'AUTHORITY_COMMITTED_AFTER_THIS_RECORD_CANNOT_RECALL_THE_IN_FLIGHT_POST',
            boundaries: { liveAuthority: 'NONE', providerCalls: 'NONE' },
          }),
        },
      });
      return { kind: 'AUTHORIZED' as const, id: row.id, basis };
    } catch (error) {
      throw new BrokerDispatchTechnicalError('FINAL_AUTHORIZATION_PERSISTENCE', error);
    }
  }, PREPARATION_TRANSACTION);
}

/** A dispatch record that committed although its caller saw an error: nothing more may be sent. */
async function throwIfDispatchRecorded(db: PrismaClient, orderIntentId: number) {
  const [consumption, unenforced] = await Promise.all([
    db.marketPolicyBrokerDispatchConsumption.findUnique({ where: { orderIntentId }, select: { id: true } }),
    db.marketPolicyBrokerUnenforcedDispatch.findUnique({ where: { orderIntentId }, select: { id: true } }),
  ]).catch(() => [null, null] as const);
  // An unreadable record stays unknown: the caller still refuses the POST, and the claim's
  // never-submitted release re-checks durable records before any release.
  if (consumption) throw new EntryDispatchRecordedNotSentError('CONSUMPTION', consumption.id);
  if (unenforced) throw new EntryDispatchRecordedNotSentError('UNENFORCED_DISPATCH', unenforced.id);
}

async function authorizeUnobligatedDispatch(db: PrismaClient, request: EntryBrokerDispatchRequest, intent: DispatchIntent, brokerPostOpportunityId: number | null) {
  let result: FinalUnobligatedAuthorization;
  try {
    result = await authorizeUnobligatedDispatchInTransaction(db, request, intent, brokerPostOpportunityId);
  } catch (error) {
    await throwIfDispatchRecorded(db, request.orderIntentId);
    throw await technicalRefusal(db, request, intent, error instanceof BrokerDispatchTechnicalError ? error : new BrokerDispatchTechnicalError('FINAL_AUTHORIZATION_COMMIT', error));
  }
  if (result.kind === 'QUARANTINED') throw await denialRefusal(request, result.decision);
}

async function recordTechnicalFailure(db: PrismaClient, request: EntryBrokerDispatchRequest, intent: DispatchIntent | null, stage: string, diagnostic: string) {
  if (!intent || intent.environment !== 'PAPER' || intent.tradingAccountId === null || intent.tradingAccountSubscriptionId === null) return null;
  try {
    const rollout = await db.marketPolicyEnforcementRuntimeRollout.findUnique({ where: { id: 1 }, select: { enabled: true, version: true } }).catch(() => null);
    const decision = await db.marketPolicyBrokerDispatchDecision.create({
      data: {
        decisionKey: randomUUID(), decisionVersion: MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION, orderIntentId: request.orderIntentId, obligationId: intent.obligationId,
        dispatchSequence: await nextDispatchSequence(db, request.orderIntentId), clientOrderId: intent.clientOrderId ?? request.clientOrderId, environment: 'PAPER',
        tradingAccountId: intent.tradingAccountId, accountSubscriptionId: intent.tradingAccountSubscriptionId,
        rolloutEnabled: rollout?.enabled ?? false, rolloutVersion: rollout?.version ?? 0, evaluatedAt: new Date(),
        outcome: 'TECHNICAL_FAILURE', reasonCode: `TECHNICAL_FAILURE_${stage}`, dispatchDisposition: 'NOT_SENT_TECHNICAL_FAILURE',
        technicalDiagnostic: diagnostic.slice(0, 500) || 'UNKNOWN',
        evidenceJson: json({ stage, diagnostic: diagnostic.slice(0, 500), semantics: 'FAIL_CLOSED_NOT_SENT; NEVER_FALLS_BACK_TO_ADMISSION_ALLOWED' }),
      },
    });
    return decision.id;
  } catch (error) {
    // Evidence delivery failure never weakens the guard: the POST still does not happen.
    logger.warn({ orderIntentId: request.orderIntentId, error }, 'Broker-time technical failure evidence could not be recorded; the entry was still not sent.');
    return null;
  }
}

async function technicalRefusal(db: PrismaClient, request: EntryBrokerDispatchRequest, intent: DispatchIntent | null, error: unknown) {
  const stage = error instanceof BrokerDispatchTechnicalError ? error.stage : 'BROKER_DISPATCH_PREPARATION';
  const diagnostic = error instanceof Error ? error.message : String(error);
  const decisionId = await recordTechnicalFailure(db, request, intent, stage, diagnostic);
  await createSystemEvent({
    type: 'MARKET_POLICY_BROKER_DISPATCH_TECHNICAL_FAILURE', entityType: 'orderIntent', entityId: request.orderIntentId,
    tradingAccountId: request.tradingAccountId, severity: 'ERROR',
    message: 'Broker-time market-policy enforcement could not complete; the entry failed closed and no broker POST was sent.',
    payloadJson: json({ decisionId, stage, diagnostic: diagnostic.slice(0, 500), clientOrderId: request.clientOrderId, deliveryClassification: 'DEFINITELY_NOT_SENT' }),
  }).catch(() => undefined);
  return new MarketPolicyBrokerDispatchRefusedError({ outcome: 'TECHNICAL_FAILURE', reasonCode: `TECHNICAL_FAILURE_${stage}`, decisionId, diagnostic: diagnostic.slice(0, 200) });
}

async function denialRefusal(request: EntryBrokerDispatchRequest, decision: DecisionResult) {
  const quarantine = decision.outcome === 'LEGACY_UNOBLIGATED_QUARANTINED';
  await createSystemEvent({
    type: quarantine ? 'MARKET_POLICY_LEGACY_ENTRY_QUARANTINED' : 'MARKET_POLICY_BROKER_DISPATCH_REFUSED',
    entityType: 'MarketPolicyBrokerDispatchDecision', entityId: decision.decisionId, tradingAccountId: request.tradingAccountId, severity: 'WARNING',
    message: quarantine
      ? 'A queued PAPER BUY without a frozen market-policy obligation was quarantined at broker time; no broker POST was sent.'
      : 'Broker-time market policy refused a new BUY dispatch; no broker POST was sent.',
    payloadJson: json({ decisionId: decision.decisionId, orderIntentId: request.orderIntentId, outcome: decision.outcome, reasonCode: decision.reasonCode, clientOrderId: request.clientOrderId, deliveryClassification: 'DEFINITELY_NOT_SENT' }),
  }).catch(() => undefined);
  return new MarketPolicyBrokerDispatchRefusedError({ outcome: decision.outcome, reasonCode: decision.reasonCode, decisionId: decision.decisionId });
}

async function consumeDecision(db: PrismaClient, decision: DecisionResult, request: EntryBrokerDispatchRequest, brokerPostOpportunityId: number | null) {
  // A single-statement transaction; PostgreSQL rechecks the window and the exact frozen authority
  // with a fresh clock and stamps consumedAt. No transaction is held across the Alpaca request.
  await db.marketPolicyBrokerDispatchConsumption.create({
    data: {
      decisionId: decision.decisionId, orderIntentId: request.orderIntentId, clientOrderId: decision.clientOrderId, brokerPostOpportunityId,
      evidenceJson: json({ dispatchExpiresAt: decision.dispatchExpiresAt, semantics: 'DISPATCH_STARTED_AFTER_COMMIT; NOT_PROOF_OF_BROKER_RECEIPT' }),
    },
  });
}

function consumptionRefusalCode(error: unknown) {
  // The PostgreSQL refusal reason may sit in the driver adapter cause rather than the message.
  let text = error instanceof Error ? error.message : String(error);
  try { text += JSON.stringify(error); } catch { /* best-effort diagnostic only */ }
  return text.match(/BROKER_DISPATCH_(?!CONSUMPTION_FAILED)[A-Z_]+/)?.[0] ?? 'BROKER_DISPATCH_CONSUMPTION_FAILED';
}

async function prepareObligated(db: PrismaClient, request: EntryBrokerDispatchRequest, intent: DispatchIntent, evaluator: MarketPolicyEvaluator) {
  let decision: DecisionResult;
  try {
    decision = await prepareObligatedDecision(db, request, intent.obligationId!, evaluator);
  } catch (error) {
    // Errors outside a classified stage are raised at commit (the deferred five-gate contract).
    throw await technicalRefusal(db, request, intent, error instanceof BrokerDispatchTechnicalError ? error : new BrokerDispatchTechnicalError('DECISION_COMMIT', error));
  }
  if (decision.outcome !== 'ALLOWED') throw await denialRefusal(request, decision);
  return decision;
}

/**
 * The single broker-time guard for every new entry BUY POST. The caller invokes it only after the
 * stable client-order-ID lookup confirmed absence, and calls `authorizeDispatch` as the last step
 * before the adapter. Any refusal is a definite non-send.
 */
export async function prepareEntryBrokerDispatch(request: EntryBrokerDispatchRequest, dependencies: BrokerDispatchDependencies = {}): Promise<PreparedEntryBrokerDispatch> {
  const db = dependencies.db ?? prisma;
  const evaluator = dependencies.evaluator ?? evaluateStrategyMarketEligibility;
  let intent: DispatchIntent;
  try {
    intent = await loadDispatchIntent(db, request.orderIntentId);
  } catch (error) {
    throw await technicalRefusal(db, request, null, new BrokerDispatchTechnicalError('INTENT_LOAD', error));
  }
  // Obligations are PAPER-only by construction. LIVE accounts have no Market Intelligence authority.
  if (intent.environment !== 'PAPER') return notApplicable('NOT_APPLICABLE_LIVE');

  if (intent.obligationId === null) {
    let applicability = 'NO_ASSIGNMENT';
    if (intent.tradingAccountSubscriptionId !== null) {
      let prepared: DecisionResult | { applicability: string };
      try {
        prepared = await prepareUnobligatedDecision(db, request, intent);
      } catch (error) {
        throw await technicalRefusal(db, request, intent, error);
      }
      if (!('applicability' in prepared)) throw await denialRefusal(request, prepared);
      applicability = prepared.applicability;
    }
    // The early read is advisory; the final serialized authorization is authoritative.
    return {
      enforcement: 'UNOBLIGATED_FINAL_AUTHORIZATION', applicability, decisionId: null, dispatchExpiresAt: null,
      authorizeDispatch: (brokerPostOpportunityId) => authorizeUnobligatedDispatch(db, request, intent, brokerPostOpportunityId),
    };
  }

  // Frozen obligation: enforced at broker time regardless of the runtime rollout state.
  const first = await prepareObligated(db, request, intent, evaluator);
  return {
    enforcement: 'FROZEN_OBLIGATION',
    applicability: 'FROZEN_OBLIGATION',
    decisionId: first.decisionId,
    dispatchExpiresAt: first.dispatchExpiresAt,
    authorizeDispatch: async (brokerPostOpportunityId) => {
      try {
        await consumeDecision(db, first, request, brokerPostOpportunityId);
        return;
      } catch (error) {
        // A consumption that committed with a lost acknowledgement prohibits any further POST.
        await throwIfDispatchRecorded(db, request.orderIntentId);
        // Not consumed, so nothing was sent. The refused decision is closed by the fresh decision
        // appended below (a superseded decision can never be consumed). Re-evaluate exactly once.
        logger.warn({ orderIntentId: request.orderIntentId, decisionId: first.decisionId, refusal: consumptionRefusalCode(error) }, 'Broker dispatch consumption was refused; re-evaluating with fresh evidence before any POST.');
      }
      const fresh = await prepareObligated(db, request, intent, evaluator);
      try {
        await consumeDecision(db, fresh, request, brokerPostOpportunityId);
      } catch (error) {
        await throwIfDispatchRecorded(db, request.orderIntentId);
        throw await technicalRefusal(db, request, intent, new BrokerDispatchTechnicalError('DISPATCH_CONSUMPTION', new Error(consumptionRefusalCode(error))));
      }
    },
  };
}

/** Owner read of the immutable broker-time decisions for one assignment, newest first. */
export async function listAssignmentMarketPolicyBrokerDispatchDecisions(accountId: number, assignmentId: number, limit = 25) {
  const assignment = await prisma.tradingAccountSubscription.findFirst({ where: { id: assignmentId, tradingAccountId: accountId }, select: { id: true } });
  if (!assignment) return null;
  const decisions = await prisma.marketPolicyBrokerDispatchDecision.findMany({
    where: { accountSubscriptionId: assignmentId },
    orderBy: { id: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    include: { gates: { orderBy: { ordinal: 'asc' } }, consumption: { select: { id: true, consumedAt: true, brokerPostOpportunityId: true } } },
  });
  return {
    authority: 'AUTHORITATIVE' as const,
    decisionVersion: MARKET_POLICY_BROKER_TIME_ENFORCEMENT_VERSION,
    decisions: decisions.map(decision => ({
      id: decision.id, orderIntentId: decision.orderIntentId, obligationId: decision.obligationId, dispatchSequence: decision.dispatchSequence,
      clientOrderId: decision.clientOrderId, outcome: decision.outcome, reasonCode: decision.reasonCode, dispatchDisposition: decision.dispatchDisposition,
      evaluatedAt: decision.evaluatedAt, validUntil: decision.validUntil, dispatchExpiresAt: decision.dispatchExpiresAt,
      authorizationId: decision.authorizationId, authorizationStatus: decision.authorizationStatus, policyRevisionId: decision.policyRevisionId,
      enrollmentGenerationId: decision.enrollmentGenerationId, marketRegimeAssessmentId: decision.marketRegimeAssessmentId,
      compositionEvidenceHealth: decision.compositionEvidenceHealth, rolloutEnabled: decision.rolloutEnabled, rolloutVersion: decision.rolloutVersion,
      technicalDiagnostic: decision.technicalDiagnostic,
      consumption: decision.consumption,
      gates: decision.gates.map(gate => ({ ordinal: gate.ordinal, dimension: gate.dimension, requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, sourceHealth: gate.sourceHealth, sourceAssessmentId: gate.sourceAssessmentId, sourceValidUntil: gate.sourceValidUntil, reasonCode: gate.reasonCode })),
    })),
  };
}

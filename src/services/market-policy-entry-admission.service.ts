import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type MarketPolicyEnforcementAdmissionOutcome,
  type MarketRegimeAssessmentSource,
  type MarketRegimeDimension,
  type OrderIntent,
  type PrismaClient,
} from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import {
  MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
  resolveLockedAssignmentMarketPolicyEnforcement,
  type LockedMarketPolicyEnforcementResolution,
  type MarketPolicyEnforcementDisposition,
} from './assignment-market-policy-enforcement-authorization.service.js';
import { acquireEntryExposureClaim } from './entry-exposure-claim.service.js';
import { lockMarketPolicyEnforcementRollout } from './market-policy-enforcement-rollout.service.js';
import { evaluateStrategyMarketEligibility, STRATEGY_MARKET_ELIGIBILITY_VERSION } from './strategy-market-eligibility.service.js';
import { createSystemEvent } from './system-event.service.js';

// Phase 3C.2 authoritative pre-intent market-policy admission. This is the single shared boundary
// through which every BUY entry OrderIntent is created. While the PAPER runtime rollout is inactive,
// or for an assignment that is not enforced, it is exactly the Phase 3C.0 claim admission. It never
// gates SELL orders, protective exits, or lifecycle reconciliation, never calls market-data
// providers, and does not implement broker-time enforcement (Phase 3C.3).
export const MARKET_POLICY_PRE_INTENT_ENFORCEMENT_VERSION = 'MARKET_POLICY_PRE_INTENT_ENFORCEMENT_V1' as const;
export const MARKET_POLICY_ENTRY_OBLIGATION_VERSION = 'MARKET_POLICY_ENTRY_OBLIGATION_V1' as const;
const COMPOSITION_VERSION = 'MARKET_REGIME_COMPOSITION_V1';
const ADMISSION_TRANSACTION = { timeout: 15_000, maxWait: 10_000 } as const;

type Evaluator = typeof evaluateStrategyMarketEligibility;
type EvaluatorRule = Parameters<Evaluator>[0][number];
type EvaluatorGate = ReturnType<Evaluator>['gates'][number];
type EvaluatedOutcome = 'ALLOWED' | 'BLOCKED' | 'INSUFFICIENT_EVIDENCE';

export type EntryAdmissionDependencies = { evaluator?: Evaluator; db?: PrismaClient };

export type EntryAdmissionRequest = {
  tradingAccountId: number;
  tradingAccountSubscriptionId: number | null;
  symbol: string;
  clientOrderId: string;
  ownerKey: string;
  requestSource: 'api' | 'live_entry_acceptance';
  createIntent: (tx: Prisma.TransactionClient) => Promise<OrderIntent>;
  // Optional pre-admission work in the same transaction (for example, live acceptance run claiming).
  // Returning an existing OrderIntent short-circuits admission as a duplicate.
  prepare?: (tx: Prisma.TransactionClient) => Promise<OrderIntent | null>;
};

export type MarketPolicyAdmissionSummary = {
  runtimeActive: boolean;
  disposition: MarketPolicyEnforcementDisposition | 'RUNTIME_INACTIVE' | 'NOT_APPLICABLE';
  enforced: boolean;
  attemptId: number | null;
  obligationId: number | null;
};

export type EntryAdmissionResult = { intent: OrderIntent; duplicate: boolean; marketPolicy: MarketPolicyAdmissionSummary };

const NON_ENFORCED_DISPOSITIONS = new Set<MarketPolicyEnforcementDisposition>(['NEVER_AUTHORIZED', 'OWNER_REVOKED', 'OWNER_OPTED_OUT', 'NOT_APPLICABLE_LIVE']);

const REJECTIONS: Record<Exclude<MarketPolicyEnforcementAdmissionOutcome, 'ALLOWED' | 'TECHNICAL_FAILURE'>, { code: string; message: string }> = {
  BLOCKED: { code: 'MARKET_POLICY_BLOCKED', message: 'Entry blocked by the assignment\'s enforced market policy.' },
  INSUFFICIENT_EVIDENCE: { code: 'MARKET_POLICY_INSUFFICIENT_EVIDENCE', message: 'Entry blocked: current market evidence is insufficient for the assignment\'s enforced market policy.' },
  AUTHORIZATION_LAPSED: { code: 'MARKET_POLICY_ENFORCEMENT_LAPSED', message: 'Entry blocked: the assignment\'s market-policy enforcement authorization was automatically invalidated. Reauthorize it or explicitly restore non-enforced behavior.' },
  AUTHORIZATION_INEFFECTIVE: { code: 'MARKET_POLICY_AUTHORIZATION_INEFFECTIVE', message: 'Entry blocked: the assignment\'s market-policy enforcement authorization no longer validates against its exact bound identity.' },
};

export const MARKET_POLICY_TECHNICAL_FAILURE_CODE = 'MARKET_POLICY_ENFORCEMENT_TECHNICAL_FAILURE';

class MarketPolicyEnforcementTechnicalError extends Error {
  constructor(readonly stage: string, readonly underlying: unknown) {
    super(`${stage}: ${underlying instanceof Error ? underlying.message : String(underlying)}`);
    this.name = 'MarketPolicyEnforcementTechnicalError';
  }
}

const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

type EvaluatedComposition = Prisma.MarketRegimeAssessmentGetPayload<{ include: { sources: true } }>;
type Evaluation = {
  outcome: EvaluatedOutcome;
  reasonCode: string;
  validUntil: Date | null;
  composition: EvaluatedComposition | null;
  gates: Prisma.MarketPolicyEnforcementAdmissionGateUncheckedCreateWithoutAttemptInput[];
};

type AdmissionState = {
  rolloutVersion?: number;
  engaged?: { resolution: LockedMarketPolicyEnforcementResolution };
  allowed?: { evaluation: Evaluation; evaluatedAt: Date };
};

type TransactionOutcome =
  | { kind: 'admitted' | 'duplicate'; intent: OrderIntent; marketPolicy: MarketPolicyAdmissionSummary }
  | { kind: 'rejected'; attempt: RejectedAttempt; marketPolicy: MarketPolicyAdmissionSummary };

type RejectedAttempt = {
  id: number; outcome: MarketPolicyEnforcementAdmissionOutcome; reasonCode: string; enforcementDisposition: string;
  policyRevisionId: number | null; authorizationId: number | null; marketRegimeAssessmentId: number | null; evaluatedAt: Date;
  gates: Array<{ dimension: string; requirement: string; outcome: string; observedState: string | null; reasonCode: string }>;
};

function attemptDisposition(disposition: MarketPolicyEnforcementDisposition | undefined) {
  if (disposition === 'ENFORCED') return 'ENFORCED';
  if (disposition === 'LAPSED') return 'LAPSED';
  if (disposition === 'AUTHORIZATION_INEFFECTIVE') return 'AUTHORIZATION_INEFFECTIVE';
  return 'UNKNOWN';
}

function compositionEvidence(composition: EvaluatedComposition | null) {
  return composition ? {
    id: composition.id, compositionVersion: composition.compositionVersion, targetAt: composition.targetAt, observedAt: composition.observedAt,
    validUntil: composition.validUntil, evidenceHealth: composition.evidenceHealth, sourceSetFingerprint: composition.sourceSetFingerprint,
  } : null;
}

function attemptIdentity(request: EntryAdmissionRequest, resolution: LockedMarketPolicyEnforcementResolution | undefined) {
  const authorization = resolution?.authorization ?? null;
  return {
    requestSource: request.requestSource, ownerKey: request.ownerKey, clientOrderId: request.clientOrderId, environment: 'PAPER' as const,
    tradingAccountId: request.tradingAccountId, accountSubscriptionId: request.tradingAccountSubscriptionId!,
    subscriptionId: resolution?.identity.subscriptionId ?? null, securityId: resolution?.identity.securityId ?? null,
    securitySymbol: resolution?.identity.securitySymbol ?? null, strategyId: resolution?.identity.strategyId ?? null,
    policyRevisionId: authorization?.policyRevisionId ?? null, enrollmentGenerationId: authorization?.enrollmentGenerationId ?? null,
    authorizationId: authorization?.id ?? null, authorizationFingerprint: authorization?.authorizationFingerprint ?? null,
    authorityVersion: authorization?.authorityVersion ?? null,
  };
}

function attemptEvidence(request: EntryAdmissionRequest, resolution: LockedMarketPolicyEnforcementResolution, rolloutVersion: number, evaluation: Evaluation | null, extra: Record<string, unknown> = {}) {
  const authorization = resolution.authorization;
  return json({
    admissionVersion: MARKET_POLICY_PRE_INTENT_ENFORCEMENT_VERSION,
    disposition: resolution.disposition,
    dispositionReasons: resolution.reasons,
    idempotency: { ownerKey: request.ownerKey, clientOrderId: request.clientOrderId },
    identity: resolution.identity,
    authorization: authorization ? {
      id: authorization.id, status: authorization.status, authorityVersion: authorization.authorityVersion, authorizationSequence: authorization.authorizationSequence,
      authorizationFingerprint: authorization.authorizationFingerprint, enrollmentGenerationId: authorization.enrollmentGenerationId,
      policyRevisionId: authorization.policyRevisionId, invalidationReasonCode: authorization.invalidationReasonCode,
    } : null,
    rollout: { version: rolloutVersion, environment: 'PAPER' },
    composition: compositionEvidence(evaluation?.composition ?? null),
    evaluation: evaluation ? { evaluatorVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION, outcome: evaluation.outcome, reasonCode: evaluation.reasonCode, validUntil: evaluation.validUntil } : null,
    boundaries: { liveAuthority: 'NONE', brokerTimeEnforcement: 'NOT_IMPLEMENTED_PHASE_3C_3', shadowDecisionReused: false },
    ...extra,
  });
}

function gateData(gate: EvaluatorGate, sources: MarketRegimeAssessmentSource[]): Prisma.MarketPolicyEnforcementAdmissionGateUncheckedCreateWithoutAttemptInput {
  const source = sources.find(item => item.dimension === gate.dimension) ?? null;
  // The composite source FK binds dimension + algorithm version; never cite a source under a different version.
  const sourceAssessmentId = source && source.requiredAlgorithmVersion === gate.algorithmVersion ? gate.sourceAssessmentId : null;
  return {
    ordinal: gate.ordinal, dimension: gate.dimension as MarketRegimeDimension, algorithmVersion: gate.algorithmVersion,
    requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, sourceHealth: gate.sourceHealth, sourceAssessmentId,
    sourceValidUntil: source?.sourceValidUntil ?? null, allowedStatesJson: json(gate.allowedStates), reasonCode: gate.reasonCode,
    evidenceJson: json({
      gate,
      source: source ? {
        id: source.id, requiredAlgorithmVersion: source.requiredAlgorithmVersion, expectedTargetAt: source.expectedTargetAt, sourceAssessmentId: source.sourceAssessmentId,
        sourceAttempt: source.sourceAttempt, sourceStatus: source.sourceStatus, sourceTargetAt: source.sourceTargetAt, sourceCompletedAt: source.sourceCompletedAt,
        sourceDataThroughAt: source.sourceDataThroughAt, sourceValidUntil: source.sourceValidUntil, sourceRawState: source.sourceRawState,
        sourceEffectiveState: source.sourceEffectiveState, compositionHealth: source.health, compositionReasonCode: source.reasonCode,
      } : null,
    }),
  };
}

/**
 * Synchronous evaluation of the exact bound revision against the current committed composition.
 * Uses the established Phase 2D gate semantics (five REQUIRED/IGNORED dimensions, required-source
 * health, version, and expiration recheck at evaluation time) but never reuses a persisted shadow
 * decision as trading authority. Missing, incomplete, unbounded, or expired evidence never ALLOWs.
 */
async function evaluateEnforcedEntry(tx: Prisma.TransactionClient, resolution: LockedMarketPolicyEnforcementResolution, evaluatedAt: Date, evaluator: Evaluator): Promise<Evaluation> {
  const revision = resolution.boundRevision;
  if (!revision) throw new Error('BOUND_POLICY_REVISION_MISSING');
  // Compositions and their five sources are immutable and inserted atomically, so this read is a
  // consistent committed snapshot. Selection matches the Phase 3B coverage capture ordering.
  const composition = await tx.marketRegimeAssessment.findFirst({
    where: { compositionVersion: COMPOSITION_VERSION, publicationStatus: 'SUCCEEDED', observedAt: { lte: evaluatedAt } },
    orderBy: [{ targetAt: 'desc' }, { observedAt: 'desc' }, { id: 'desc' }],
    include: { sources: { orderBy: { ordinal: 'asc' } } },
  });
  if (!composition) return { outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NO_COMPOSITION', validUntil: null, composition: null, gates: [] };
  const result = evaluator(revision.dimensionRules as EvaluatorRule[], composition.sources, evaluatedAt);
  if (result.gates.length !== 5) throw new Error('EVALUATOR_GATES_INCOMPLETE');
  if (!['ALLOWED', 'BLOCKED', 'INSUFFICIENT_EVIDENCE'].includes(result.outcome)) throw new Error('EVALUATOR_OUTCOME_INVALID');
  let outcome = result.outcome as EvaluatedOutcome;
  let reasonCode = result.reasonCode;
  if (composition.sources.length !== 5) { outcome = 'INSUFFICIENT_EVIDENCE'; reasonCode = 'COMPOSITION_INCOMPLETE'; }
  if (outcome === 'ALLOWED' && (!result.validUntil || result.validUntil.getTime() <= evaluatedAt.getTime())) { outcome = 'INSUFFICIENT_EVIDENCE'; reasonCode = 'REQUIRED_EVIDENCE_VALIDITY_UNBOUNDED'; }
  return { outcome, reasonCode, validUntil: outcome === 'ALLOWED' ? result.validUntil : null, composition, gates: result.gates.map(gate => gateData(gate, composition.sources)) };
}

async function legacyAdmission(tx: Prisma.TransactionClient, request: EntryAdmissionRequest, marketPolicy: MarketPolicyAdmissionSummary): Promise<TransactionOutcome> {
  const acquired = await acquireEntryExposureClaim({
    tx, tradingAccountId: request.tradingAccountId, symbol: request.symbol, ownerKey: request.ownerKey, createIntent: () => request.createIntent(tx),
  });
  return { kind: acquired.duplicate ? 'duplicate' : 'admitted', intent: acquired.intent, marketPolicy };
}

function presentRejected(attempt: Prisma.MarketPolicyEnforcementAdmissionAttemptGetPayload<{ include: { gates: true } }>): RejectedAttempt {
  return {
    id: attempt.id, outcome: attempt.outcome, reasonCode: attempt.reasonCode, enforcementDisposition: attempt.enforcementDisposition,
    policyRevisionId: attempt.policyRevisionId, authorizationId: attempt.authorizationId, marketRegimeAssessmentId: attempt.marketRegimeAssessmentId,
    evaluatedAt: attempt.evaluatedAt,
    gates: attempt.gates.sort((left, right) => left.ordinal - right.ordinal).map(gate => ({ dimension: gate.dimension, requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, reasonCode: gate.reasonCode })),
  };
}

async function admitInTransaction(tx: Prisma.TransactionClient, request: EntryAdmissionRequest, evaluator: Evaluator, state: AdmissionState): Promise<TransactionOutcome> {
  const prepared = request.prepare ? await request.prepare(tx) : null;
  if (prepared) return { kind: 'duplicate', intent: prepared, marketPolicy: { runtimeActive: false, disposition: 'NOT_APPLICABLE', enforced: false, attemptId: null, obligationId: null } };

  // Lock order step 1: the runtime rollout row (FOR SHARE).
  const rollout = await lockMarketPolicyEnforcementRollout(tx);
  if (!rollout.enabled) return legacyAdmission(tx, request, { runtimeActive: false, disposition: 'RUNTIME_INACTIVE', enforced: false, attemptId: null, obligationId: null });
  if (request.tradingAccountSubscriptionId === null) return legacyAdmission(tx, request, { runtimeActive: true, disposition: 'NOT_APPLICABLE', enforced: false, attemptId: null, obligationId: null });
  state.rolloutVersion = rollout.version;

  // Lock order steps 2-6: account, assignment, subscription, security, latest authorization.
  let resolution: LockedMarketPolicyEnforcementResolution;
  try {
    resolution = await resolveLockedAssignmentMarketPolicyEnforcement(tx, request.tradingAccountSubscriptionId);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new MarketPolicyEnforcementTechnicalError('AUTHORIZATION_RESOLUTION', error);
  }
  if (NON_ENFORCED_DISPOSITIONS.has(resolution.disposition)) {
    return legacyAdmission(tx, request, { runtimeActive: true, disposition: resolution.disposition, enforced: false, attemptId: null, obligationId: null });
  }
  state.engaged = { resolution };
  const marketPolicy: MarketPolicyAdmissionSummary = { runtimeActive: true, disposition: resolution.disposition, enforced: true, attemptId: null, obligationId: null };
  if (request.tradingAccountId !== resolution.identity.tradingAccountId) throw new MarketPolicyEnforcementTechnicalError('REQUEST_ACCOUNT_MISMATCH', new Error('Admission account does not own the assignment.'));
  if (request.symbol.trim().toUpperCase() !== resolution.identity.securitySymbol) {
    throw new MarketPolicyEnforcementTechnicalError('REQUEST_SECURITY_MISMATCH', new Error(`Requested ${request.symbol} does not equal the assignment Security ${resolution.identity.securitySymbol}.`));
  }

  // Lock order step 7: the entry-exposure advisory lock. A retry of an already accepted stable owner
  // key recovers its existing lifecycle without a second decision or entry.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`entry-exposure:${request.tradingAccountId}:${resolution.identity.securityId}`}, 0))::text`;
  const prior = await tx.entryExposureClaim.findUnique({ where: { ownerKey: request.ownerKey }, include: { orderIntent: true } });
  if (prior?.orderIntent) return { kind: 'duplicate', intent: prior.orderIntent, marketPolicy };

  const [clock] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS at`;
  const evaluatedAt = clock!.at;
  const identity = attemptIdentity(request, resolution);
  const base = { attemptKey: randomUUID(), admissionVersion: MARKET_POLICY_PRE_INTENT_ENFORCEMENT_VERSION, rolloutVersion: rollout.version, evaluatedAt, ...identity };

  if (resolution.disposition === 'LAPSED' || resolution.disposition === 'AUTHORIZATION_INEFFECTIVE') {
    const outcome = resolution.disposition === 'LAPSED' ? 'AUTHORIZATION_LAPSED' as const : 'AUTHORIZATION_INEFFECTIVE' as const;
    const attempt = await tx.marketPolicyEnforcementAdmissionAttempt.create({
      data: {
        ...base, enforcementDisposition: attemptDisposition(resolution.disposition), outcome,
        reasonCode: resolution.disposition === 'LAPSED' ? `AUTHORIZATION_INVALIDATED_${resolution.authorization?.invalidationReasonCode ?? 'UNKNOWN'}` : (resolution.reasons[0] ?? 'AUTHORIZATION_INEFFECTIVE'),
        orderIntentCreated: false, admissionResultCode: REJECTIONS[outcome].code, evidenceJson: attemptEvidence(request, resolution, rollout.version, null),
      },
      include: { gates: true },
    });
    return { kind: 'rejected', attempt: presentRejected(attempt), marketPolicy: { ...marketPolicy, attemptId: attempt.id } };
  }

  let evaluation: Evaluation;
  try {
    evaluation = await evaluateEnforcedEntry(tx, resolution, evaluatedAt, evaluator);
  } catch (error) {
    throw new MarketPolicyEnforcementTechnicalError('MARKET_EVALUATION', error);
  }
  const evaluated = {
    ...base, enforcementDisposition: 'ENFORCED', evaluatorVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION,
    authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
    marketRegimeAssessmentId: evaluation.composition?.id ?? null, compositionVersion: evaluation.composition?.compositionVersion ?? null,
    compositionSourceSetFingerprint: evaluation.composition?.sourceSetFingerprint ?? null, compositionEvidenceHealth: evaluation.composition?.evidenceHealth ?? null,
    validUntil: evaluation.validUntil, outcome: evaluation.outcome, reasonCode: evaluation.reasonCode,
  };

  if (evaluation.outcome !== 'ALLOWED') {
    const attempt = await tx.marketPolicyEnforcementAdmissionAttempt.create({
      data: {
        ...evaluated, orderIntentCreated: false, admissionResultCode: REJECTIONS[evaluation.outcome].code,
        evidenceJson: attemptEvidence(request, resolution, rollout.version, evaluation), gates: { create: evaluation.gates },
      },
      include: { gates: true },
    });
    return { kind: 'rejected', attempt: presentRejected(attempt), marketPolicy: { ...marketPolicy, attemptId: attempt.id } };
  }

  // ALLOWED is not permission to bypass anything else: existing claim acquisition and the ordinary
  // risk gate still apply. The claim, the OrderIntent, the attempt and the frozen obligation commit
  // atomically, or not at all.
  state.allowed = { evaluation, evaluatedAt };
  const acquired = await acquireEntryExposureClaim({
    tx, tradingAccountId: request.tradingAccountId, symbol: request.symbol, ownerKey: request.ownerKey, createIntent: () => request.createIntent(tx),
  });
  if (acquired.duplicate) return { kind: 'duplicate', intent: acquired.intent, marketPolicy };
  try {
    const attempt = await tx.marketPolicyEnforcementAdmissionAttempt.create({
      data: {
        ...evaluated, orderIntentId: acquired.intent.id, orderIntentCreated: true, admissionResultCode: 'ORDER_INTENT_CREATED',
        evidenceJson: attemptEvidence(request, resolution, rollout.version, evaluation, { orderIntentId: acquired.intent.id, entryExposureClaimId: acquired.claimId }),
        gates: { create: evaluation.gates },
      },
    });
    const authorization = resolution.authorization!;
    const obligation = await tx.orderIntentMarketPolicyEnforcementObligation.create({
      data: {
        orderIntentId: acquired.intent.id, admissionAttemptId: attempt.id, obligationVersion: MARKET_POLICY_ENTRY_OBLIGATION_VERSION, environment: 'PAPER',
        tradingAccountId: attempt.tradingAccountId, accountSubscriptionId: attempt.accountSubscriptionId, subscriptionId: attempt.subscriptionId!,
        securityId: attempt.securityId!, securitySymbol: attempt.securitySymbol!, strategyId: attempt.strategyId!, policyRevisionId: attempt.policyRevisionId!,
        enrollmentGenerationId: attempt.enrollmentGenerationId!, authorizationId: attempt.authorizationId!, authorizationFingerprint: attempt.authorizationFingerprint!,
        authorityVersion: attempt.authorityVersion!, admissionVersion: attempt.admissionVersion, evaluatorVersion: attempt.evaluatorVersion!,
        marketRegimeAssessmentId: attempt.marketRegimeAssessmentId!, compositionSourceSetFingerprint: attempt.compositionSourceSetFingerprint!,
        evaluatedAt: attempt.evaluatedAt, validUntil: attempt.validUntil!, rolloutVersion: attempt.rolloutVersion,
        frozenContextJson: json({
          attemptKey: attempt.attemptKey, entryExposureClaimId: acquired.claimId, identity: resolution.identity,
          authorization: { id: authorization.id, authorizationSequence: authorization.authorizationSequence, authorityVersion: authorization.authorityVersion, authorizationFingerprint: authorization.authorizationFingerprint, configurationFingerprint: authorization.configurationFingerprint },
          policyRevisionId: authorization.policyRevisionId, enrollmentGenerationId: authorization.enrollmentGenerationId,
          composition: compositionEvidence(evaluation.composition),
          gates: evaluation.gates.map(gate => ({ ordinal: gate.ordinal, dimension: gate.dimension, requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, sourceValidUntil: gate.sourceValidUntil, reasonCode: gate.reasonCode })),
          rolloutVersion: rollout.version, evaluatorVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION,
          semantics: 'DURABLE_PER_INTENT_OBLIGATION; NOT_A_POINTER_TO_CURRENT_POLICY',
        }),
      },
    });
    return { kind: 'admitted', intent: acquired.intent, marketPolicy: { ...marketPolicy, attemptId: attempt.id, obligationId: obligation.id } };
  } catch (error) {
    throw new MarketPolicyEnforcementTechnicalError('OBLIGATION_FREEZE', error);
  }
}

async function recordTechnicalFailure(db: PrismaClient, request: EntryAdmissionRequest, state: AdmissionState, stage: string, diagnostic: string) {
  try {
    const resolution = state.engaged?.resolution;
    const attempt = await db.marketPolicyEnforcementAdmissionAttempt.create({
      data: {
        attemptKey: randomUUID(), admissionVersion: MARKET_POLICY_PRE_INTENT_ENFORCEMENT_VERSION, rolloutVersion: state.rolloutVersion!,
        evaluatedAt: new Date(), ...attemptIdentity(request, resolution), enforcementDisposition: attemptDisposition(resolution?.disposition),
        outcome: 'TECHNICAL_FAILURE', reasonCode: `TECHNICAL_FAILURE_${stage}`, orderIntentCreated: false,
        admissionResultCode: 'NOT_ADMITTED_TECHNICAL_FAILURE', technicalDiagnostic: diagnostic.slice(0, 500) || 'UNKNOWN',
        evidenceJson: json({ stage, diagnostic: diagnostic.slice(0, 500), disposition: resolution?.disposition ?? null, rolloutVersion: state.rolloutVersion, boundaries: { liveAuthority: 'NONE' } }),
      },
    });
    return attempt.id;
  } catch {
    // Evidence delivery failure never weakens the gate: the entry was still not admitted.
    return null;
  }
}

async function recordAllowedNotAdmitted(db: PrismaClient, request: EntryAdmissionRequest, state: AdmissionState, admissionResultCode: string) {
  const resolution = state.engaged?.resolution;
  const allowed = state.allowed;
  if (!resolution || !allowed) return null;
  try {
    const attempt = await db.marketPolicyEnforcementAdmissionAttempt.create({
      data: {
        attemptKey: randomUUID(), admissionVersion: MARKET_POLICY_PRE_INTENT_ENFORCEMENT_VERSION, rolloutVersion: state.rolloutVersion!,
        evaluatedAt: allowed.evaluatedAt, ...attemptIdentity(request, resolution), enforcementDisposition: 'ENFORCED',
        evaluatorVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION, authorityVersion: MARKET_POLICY_ENFORCEMENT_AUTHORITY_VERSION,
        marketRegimeAssessmentId: allowed.evaluation.composition?.id ?? null, compositionVersion: allowed.evaluation.composition?.compositionVersion ?? null,
        compositionSourceSetFingerprint: allowed.evaluation.composition?.sourceSetFingerprint ?? null, compositionEvidenceHealth: allowed.evaluation.composition?.evidenceHealth ?? null,
        validUntil: allowed.evaluation.validUntil, outcome: 'ALLOWED', reasonCode: allowed.evaluation.reasonCode, orderIntentCreated: false,
        admissionResultCode, evidenceJson: attemptEvidence(request, resolution, state.rolloutVersion!, allowed.evaluation, { notAdmittedBecause: admissionResultCode }),
        gates: { create: allowed.evaluation.gates },
      },
    });
    return attempt.id;
  } catch {
    return null;
  }
}

function errorCode(error: HttpError) {
  const details = error.details;
  if (details && typeof details === 'object' && !Array.isArray(details) && typeof (details as Record<string, unknown>).code === 'string') return (details as { code: string }).code;
  return `HTTP_${error.statusCode}`;
}

/**
 * The shared entry admission boundary. Every BUY entry OrderIntent is created here.
 *
 * Outcomes for an enforced PAPER assignment under an active rollout:
 * - ALLOWED: the claim, OrderIntent, immutable attempt, and frozen obligation commit atomically.
 * - BLOCKED / INSUFFICIENT_EVIDENCE / AUTHORIZATION_LAPSED / AUTHORIZATION_INEFFECTIVE: the immutable
 *   attempt commits first, then a 403 with a stable `details.code` is raised. No OrderIntent,
 *   EntryExposureClaim, BrokerOrder, or broker POST exists.
 * - Technical failure: everything rolls back, a TECHNICAL_FAILURE attempt is recorded best-effort in
 *   a separate transaction, and a 503 (`MARKET_POLICY_ENFORCEMENT_TECHNICAL_FAILURE`) is raised.
 */
export async function admitEntryOrderIntent(request: EntryAdmissionRequest, dependencies: EntryAdmissionDependencies = {}): Promise<EntryAdmissionResult> {
  const db = dependencies.db ?? prisma;
  const evaluator = dependencies.evaluator ?? evaluateStrategyMarketEligibility;
  const state: AdmissionState = {};
  let outcome: TransactionOutcome;
  try {
    outcome = await db.$transaction(tx => admitInTransaction(tx, request, evaluator, state), ADMISSION_TRANSACTION);
  } catch (error) {
    const technical = error instanceof MarketPolicyEnforcementTechnicalError || (state.engaged !== undefined && !(error instanceof HttpError));
    if (technical) {
      const stage = error instanceof MarketPolicyEnforcementTechnicalError ? error.stage : 'ADMISSION_TRANSACTION';
      const diagnostic = error instanceof Error ? error.message : String(error);
      const attemptId = await recordTechnicalFailure(db, request, state, stage, diagnostic);
      await createSystemEvent({
        type: 'MARKET_POLICY_ENTRY_ENFORCEMENT_TECHNICAL_FAILURE', entityType: 'TradingAccountSubscription', entityId: request.tradingAccountSubscriptionId ?? 0,
        tradingAccountId: request.tradingAccountId, severity: 'ERROR',
        message: 'Market-policy enforcement could not complete; the entry failed closed without an OrderIntent.',
        payloadJson: json({ attemptId, stage, diagnostic: diagnostic.slice(0, 500), clientOrderId: request.clientOrderId, orderIntentCreated: false }),
      }).catch(() => undefined);
      throw new HttpError(503, 'Market-policy enforcement could not complete; the entry was not admitted.', json({
        code: MARKET_POLICY_TECHNICAL_FAILURE_CODE, attemptId, stage, diagnostic: diagnostic.slice(0, 500), orderIntentCreated: false,
      }));
    }
    if (error instanceof HttpError && state.allowed) await recordAllowedNotAdmitted(db, request, state, errorCode(error));
    throw error;
  }

  if (outcome.kind === 'rejected') {
    const rejection = REJECTIONS[outcome.attempt.outcome as keyof typeof REJECTIONS];
    await createSystemEvent({
      type: 'MARKET_POLICY_ENTRY_REJECTED', entityType: 'MarketPolicyEnforcementAdmissionAttempt', entityId: outcome.attempt.id,
      tradingAccountId: request.tradingAccountId, severity: 'WARNING', message: rejection.message,
      payloadJson: json({ ...outcome.attempt, code: rejection.code, accountSubscriptionId: request.tradingAccountSubscriptionId, clientOrderId: request.clientOrderId, orderIntentCreated: false }),
    }).catch(() => undefined);
    throw new HttpError(403, rejection.message, json({
      code: rejection.code, attemptId: outcome.attempt.id, outcome: outcome.attempt.outcome, reasonCode: outcome.attempt.reasonCode,
      enforcementDisposition: outcome.attempt.enforcementDisposition, accountSubscriptionId: request.tradingAccountSubscriptionId,
      policyRevisionId: outcome.attempt.policyRevisionId, authorizationId: outcome.attempt.authorizationId,
      marketRegimeAssessmentId: outcome.attempt.marketRegimeAssessmentId, evaluatedAt: outcome.attempt.evaluatedAt,
      gates: outcome.attempt.gates, orderIntentCreated: false,
    }));
  }

  if (outcome.kind === 'admitted' && outcome.marketPolicy.attemptId) {
    await createSystemEvent({
      type: 'MARKET_POLICY_ENTRY_ADMITTED', entityType: 'MarketPolicyEnforcementAdmissionAttempt', entityId: outcome.marketPolicy.attemptId,
      tradingAccountId: request.tradingAccountId,
      message: 'Enforced market policy ALLOWED the entry; its obligation was frozen with the OrderIntent.',
      payloadJson: json({ attemptId: outcome.marketPolicy.attemptId, obligationId: outcome.marketPolicy.obligationId, orderIntentId: outcome.intent.id, accountSubscriptionId: request.tradingAccountSubscriptionId }),
    }).catch(() => undefined);
  }
  return { intent: outcome.intent, duplicate: outcome.kind === 'duplicate', marketPolicy: outcome.marketPolicy };
}

/** Owner read of the immutable authoritative admission attempts (and frozen obligations) for one assignment. */
export async function listAssignmentMarketPolicyEnforcementAdmissionAttempts(accountId: number, assignmentId: number, limit = 25) {
  const assignment = await prisma.tradingAccountSubscription.findFirst({ where: { id: assignmentId, tradingAccountId: accountId }, select: { id: true } });
  if (!assignment) return null;
  const attempts = await prisma.marketPolicyEnforcementAdmissionAttempt.findMany({
    where: { accountSubscriptionId: assignmentId },
    orderBy: { id: 'desc' },
    take: limit,
    include: { gates: { orderBy: { ordinal: 'asc' } }, obligation: { select: { id: true, orderIntentId: true, frozenAt: true, validUntil: true, authorizationId: true, policyRevisionId: true } } },
  });
  return {
    authority: 'AUTHORITATIVE' as const,
    admissionVersion: MARKET_POLICY_PRE_INTENT_ENFORCEMENT_VERSION,
    attempts: attempts.map(attempt => ({
      id: attempt.id, outcome: attempt.outcome, reasonCode: attempt.reasonCode, enforcementDisposition: attempt.enforcementDisposition,
      admissionResultCode: attempt.admissionResultCode, orderIntentCreated: attempt.orderIntentCreated, orderIntentId: attempt.orderIntentId,
      requestSource: attempt.requestSource, clientOrderId: attempt.clientOrderId, evaluatedAt: attempt.evaluatedAt, validUntil: attempt.validUntil,
      authorizationId: attempt.authorizationId, authorizationFingerprint: attempt.authorizationFingerprint, policyRevisionId: attempt.policyRevisionId,
      enrollmentGenerationId: attempt.enrollmentGenerationId, securityId: attempt.securityId, securitySymbol: attempt.securitySymbol,
      marketRegimeAssessmentId: attempt.marketRegimeAssessmentId, compositionEvidenceHealth: attempt.compositionEvidenceHealth,
      rolloutVersion: attempt.rolloutVersion, technicalDiagnostic: attempt.technicalDiagnostic,
      gates: attempt.gates.map(gate => ({ ordinal: gate.ordinal, dimension: gate.dimension, requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, sourceHealth: gate.sourceHealth, sourceAssessmentId: gate.sourceAssessmentId, sourceValidUntil: gate.sourceValidUntil, reasonCode: gate.reasonCode })),
      obligation: attempt.obligation,
    })),
  };
}

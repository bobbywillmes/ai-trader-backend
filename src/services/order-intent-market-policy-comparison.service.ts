import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { evaluateStrategyMarketEligibility } from './strategy-market-eligibility.service.js';

export const ORDER_INTENT_MARKET_POLICY_COMPARISON_VERSION = 'ORDER_INTENT_MARKET_POLICY_COMPARISON_V1';
export const ORDER_INTENT_MARKET_POLICY_COMPARISON_MAX_ATTEMPTS = 3;
export const ORDER_INTENT_MARKET_POLICY_COMPARISON_BATCH_MAX = 25;
const LEASE_MS = 60_000;

type Db = PrismaClient;
type Evaluation = ReturnType<typeof evaluateStrategyMarketEligibility>;
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export async function seedOrderIntentMarketPolicyComparisonDeliveries(limit = 25, db: Db = prisma) {
  if (!Number.isInteger(limit) || limit < 1 || limit > ORDER_INTENT_MARKET_POLICY_COMPARISON_BATCH_MAX) throw new RangeError('Comparison seed limit must be between 1 and 25.');
  const inserted = await db.$executeRaw`
    INSERT INTO "OrderIntentMarketPolicyComparisonDelivery" ("coverageId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt")
    SELECT c.id,'PENDING'::"OrderIntentMarketPolicyComparisonDeliveryStatus",0,statement_timestamp(),statement_timestamp(),statement_timestamp()
    FROM "OrderIntentMarketPolicyCoverage" c
    CROSS JOIN "OrderIntentMarketPolicyComparisonRollout" r
    WHERE r.id=1 AND r.enabled
      AND c."captureSchemaVersion"=2 AND c."compositionCapture"='EXACT'
      AND c.provenance IN ('ACTIVE_EXACT','SUPERSEDED_COMPARE_ONLY')
      AND c."enrollmentGenerationId" IS NOT NULL AND c."boundPolicyRevisionId" IS NOT NULL AND c."marketRegimeAssessmentId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "OrderIntentMarketPolicyComparisonDelivery" d WHERE d."coverageId"=c.id)
    ORDER BY c.id LIMIT ${limit}
    ON CONFLICT ("coverageId") DO NOTHING`;
  return inserted;
}

async function claimDelivery(workerId: string, db: Db) {
  return db.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{ id: number; coverageId: number; attemptCount: number }>>`
      WITH candidate AS (
        SELECT d.id FROM "OrderIntentMarketPolicyComparisonDelivery" d
        CROSS JOIN "OrderIntentMarketPolicyComparisonRollout" r
        WHERE r.id=1 AND r.enabled AND d."attemptCount" < ${ORDER_INTENT_MARKET_POLICY_COMPARISON_MAX_ATTEMPTS}
          AND ((d.status IN ('PENDING','RETRY_WAIT') AND d."nextAttemptAt" <= statement_timestamp())
            OR (d.status='CLAIMED' AND d."leaseExpiresAt" <= statement_timestamp()))
        ORDER BY d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1
      )
      UPDATE "OrderIntentMarketPolicyComparisonDelivery" d SET status='CLAIMED',
        "attemptCount"=d."attemptCount"+1,"leaseOwner"=${workerId},
        "leaseExpiresAt"=statement_timestamp()+interval '60 seconds',"updatedAt"=statement_timestamp()
      FROM candidate WHERE d.id=candidate.id
      RETURNING d.id,d."coverageId",d."attemptCount"`;
    return rows[0] ?? null;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

const includeCoverage = {
  enrollmentGeneration: true,
  boundPolicyRevision: { include: { dimensionRules: { include: { allowedStates: true } } } },
  marketRegimeAssessment: { include: { sources: true } },
} satisfies Prisma.OrderIntentMarketPolicyCoverageInclude;

async function completeClaim(claim: { id: number; coverageId: number; attemptCount: number }, workerId: string, db: Db,
  evaluator: typeof evaluateStrategyMarketEligibility) {
  const coverage = await db.orderIntentMarketPolicyCoverage.findUnique({ where: { id: claim.coverageId }, include: includeCoverage });
  if (!coverage?.enrollmentGeneration || !coverage.boundPolicyRevision || !coverage.marketRegimeAssessment) throw new Error('EXACT_COVERAGE_IDENTITY_MISSING');
  const disposition = coverage.provenance === 'ACTIVE_EXACT' ? 'ACTIVE' : 'SUPERSEDED_DIAGNOSTIC';
  try {
    const result = evaluator(coverage.boundPolicyRevision.dimensionRules, coverage.marketRegimeAssessment.sources, coverage.capturedAt);
    await db.$transaction(async tx => {
      const current = await tx.orderIntentMarketPolicyComparisonDelivery.findUnique({ where: { id: claim.id } });
      if (!current || current.status !== 'CLAIMED' || current.leaseOwner !== workerId) return;
      const existing = await tx.orderIntentMarketPolicyComparisonAttempt.findFirst({ where: { coverageId: coverage.id, outcome: { not: 'TECHNICAL_FAILURE' } } });
      if (!existing) await persistAttempt(tx, coverage, claim.attemptCount, disposition, result);
      await tx.orderIntentMarketPolicyComparisonDelivery.update({ where: { id: claim.id }, data: { status: 'COMPLETED', leaseOwner: null, leaseExpiresAt: null, lastErrorCode: null, completedAt: new Date() } });
    });
    return 'COMPLETED' as const;
  } catch (error) {
    const errorCode = error instanceof Error ? error.message.slice(0, 120) : 'UNKNOWN_EVALUATION_FAILURE';
    await db.$transaction(async tx => {
      const current = await tx.orderIntentMarketPolicyComparisonDelivery.findUnique({ where: { id: claim.id } });
      if (!current || current.status !== 'CLAIMED' || current.leaseOwner !== workerId) return;
      await tx.orderIntentMarketPolicyComparisonAttempt.create({ data: {
        coverageId: coverage.id, attempt: claim.attemptCount, strategyId: coverage.enrollmentGeneration!.strategyId,
        enrollmentGenerationId: coverage.enrollmentGenerationId!, policyRevisionId: coverage.boundPolicyRevisionId!,
        marketRegimeAssessmentId: coverage.marketRegimeAssessmentId!, evidenceAsOf: coverage.capturedAt,
        evaluationVersion: ORDER_INTENT_MARKET_POLICY_COMPARISON_VERSION, enrollmentDisposition: disposition,
        outcome: 'TECHNICAL_FAILURE', reasonCode: 'EVALUATION_TECHNICAL_FAILURE', authority: 'COMPARE_ONLY', tradingEffect: 'NONE',
        evidenceJson: json({ errorCode }),
      } });
      const terminal = claim.attemptCount >= ORDER_INTENT_MARKET_POLICY_COMPARISON_MAX_ATTEMPTS;
      await tx.orderIntentMarketPolicyComparisonDelivery.update({ where: { id: claim.id }, data: {
        status: terminal ? 'TERMINAL_FAILURE' : 'RETRY_WAIT', leaseOwner: null, leaseExpiresAt: null,
        lastErrorCode: errorCode, nextAttemptAt: new Date(Date.now() + claim.attemptCount * 30_000), completedAt: terminal ? new Date() : null,
      } });
    });
    return claim.attemptCount >= ORDER_INTENT_MARKET_POLICY_COMPARISON_MAX_ATTEMPTS ? 'TERMINAL_FAILURE' as const : 'RETRY_WAIT' as const;
  }
}

async function persistAttempt(tx: Prisma.TransactionClient, coverage: NonNullable<Awaited<ReturnType<Db['orderIntentMarketPolicyCoverage']['findUnique']>>> & any,
  attempt: number, disposition: string, result: Evaluation) {
  const canonical = { coverageId: coverage.id, orderIntentId: coverage.orderIntentId, evaluationVersion: ORDER_INTENT_MARKET_POLICY_COMPARISON_VERSION,
    evidenceAsOf: coverage.capturedAt.toISOString(), disposition, outcome: result.outcome, reasonCode: result.reasonCode };
  await tx.orderIntentMarketPolicyComparisonAttempt.create({ data: {
    coverageId: coverage.id, attempt, strategyId: coverage.enrollmentGeneration.strategyId,
    enrollmentGenerationId: coverage.enrollmentGenerationId, policyRevisionId: coverage.boundPolicyRevisionId,
    marketRegimeAssessmentId: coverage.marketRegimeAssessmentId, evidenceAsOf: coverage.capturedAt,
    evaluationVersion: ORDER_INTENT_MARKET_POLICY_COMPARISON_VERSION, enrollmentDisposition: disposition,
    outcome: result.outcome as 'ALLOWED' | 'BLOCKED' | 'INSUFFICIENT_EVIDENCE', reasonCode: result.reasonCode, authority: 'COMPARE_ONLY', tradingEffect: 'NONE', evidenceJson: json(canonical),
    gates: { create: result.gates.map(gate => ({ dimension: gate.dimension as any, algorithmVersion: gate.algorithmVersion,
      requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, sourceHealth: gate.sourceHealth,
      sourceAssessmentId: gate.sourceAssessmentId, allowedStatesJson: gate.allowedStates, reasonCode: gate.reasonCode,
      evidenceJson: json(gate), ordinal: gate.ordinal })) },
  } });
}

export async function processOrderIntentMarketPolicyComparisons(options: {
  limit?: number; workerId?: string; db?: Db; evaluator?: typeof evaluateStrategyMarketEligibility;
} = {}) {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > ORDER_INTENT_MARKET_POLICY_COMPARISON_BATCH_MAX) throw new RangeError('Comparison processing limit must be between 1 and 25.');
  const db = options.db ?? prisma; const workerId = options.workerId ?? randomUUID();
  const rollout = await db.orderIntentMarketPolicyComparisonRollout.findUnique({ where: { id: 1 } });
  if (!rollout?.enabled) return { enabled: false, seeded: 0, claimed: 0, completed: 0, retrying: 0, terminalFailures: 0 };
  const seeded = await seedOrderIntentMarketPolicyComparisonDeliveries(limit, db);
  let claimed = 0, completed = 0, retrying = 0, terminalFailures = 0;
  for (let index = 0; index < limit; index += 1) {
    const claim = await claimDelivery(workerId, db); if (!claim) break; claimed += 1;
    const outcome = await completeClaim(claim, workerId, db, options.evaluator ?? evaluateStrategyMarketEligibility);
    if (outcome === 'COMPLETED') completed += 1; else if (outcome === 'RETRY_WAIT') retrying += 1; else terminalFailures += 1;
  }
  return { enabled: true, seeded, claimed, completed, retrying, terminalFailures };
}

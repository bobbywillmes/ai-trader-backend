import { Prisma, type OrderIntentBrokerOpportunityApplicability, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';

type CoverageAnchor = { environment: string; provenance: string; captureSchemaVersion: number };

export function resolveBrokerOpportunityApplicability(anchor: CoverageAnchor): OrderIntentBrokerOpportunityApplicability {
  if (anchor.environment === 'LIVE') return 'NOT_APPLICABLE_LIVE';
  if (anchor.captureSchemaVersion < 2) return 'NOT_APPLICABLE_LEGACY';
  if (anchor.provenance === 'ACTIVE_EXACT') return 'APPLICABLE_ACTIVE';
  if (anchor.provenance === 'SUPERSEDED_COMPARE_ONLY') return 'APPLICABLE_SUPERSEDED';
  if (anchor.provenance === 'UNENROLLED') return 'NOT_APPLICABLE_UNENROLLED';
  return 'NOT_APPLICABLE_UNKNOWN';
}

export async function captureOrderIntentBrokerPostOpportunity(input: {
  orderIntentId: number;
  opportunitySequence: number;
  idempotencyKey: string;
}, db: PrismaClient = prisma) {
  if (!Number.isInteger(input.opportunitySequence) || input.opportunitySequence < 1) throw new RangeError('Opportunity sequence must be positive.');
  if (!input.idempotencyKey.trim()) throw new RangeError('Opportunity idempotency key is required.');

  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.idempotencyKey},0))::text`;
    const existing = await tx.orderIntentBrokerPostOpportunity.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.orderIntentId !== input.orderIntentId || existing.opportunitySequence !== input.opportunitySequence) throw new Error('BROKER_OPPORTUNITY_IDEMPOTENCY_CONFLICT');
      return existing;
    }
    const anchors = await tx.$queryRaw<Array<{
      orderIntentId: number; coverageId: number; tradingAccountId: number; accountSubscriptionId: number;
      clientOrderId: string; environment: string; provenance: string; captureSchemaVersion: number;
      enrollmentGenerationId: number | null; boundPolicyRevisionId: number | null;
      marketRegimeAssessmentId: number | null; sourceSetFingerprint: string | null; opportunityAt: Date;
    }>>(Prisma.sql`
      SELECT i.id AS "orderIntentId",c.id AS "coverageId",c."tradingAccountId",c."accountSubscriptionId",
        i."clientOrderId",a.environment::text,c.provenance::text,c."captureSchemaVersion",
        c."enrollmentGenerationId",c."boundPolicyRevisionId",m.id AS "marketRegimeAssessmentId",
        m."sourceSetFingerprint",statement_timestamp() AS "opportunityAt"
      FROM "OrderIntent" i
      JOIN "OrderIntentMarketPolicyCoverage" c ON c."orderIntentId"=i.id
      JOIN "TradingAccount" a ON a.id=c."tradingAccountId"
      JOIN "OrderIntentBrokerOpportunityCaptureRollout" r ON r.id=1 AND r.enabled
        AND r."effectiveEpoch" IS NOT NULL AND statement_timestamp()>=r."effectiveEpoch"
      LEFT JOIN LATERAL (
        SELECT x.id,x."sourceSetFingerprint" FROM "MarketRegimeAssessment" x
        WHERE x."compositionVersion"='MARKET_REGIME_COMPOSITION_V1' AND x."publicationStatus"='SUCCEEDED'
          AND x."observedAt"<=statement_timestamp()
        ORDER BY x."targetAt" DESC,x."observedAt" DESC,x.id DESC LIMIT 1
      ) m ON true
      WHERE i.id=${input.orderIntentId} AND i.side='buy' AND i."clientOrderId" IS NOT NULL
      FOR SHARE OF i,c,a`);
    const anchor = anchors[0];
    if (!anchor) throw new Error('BROKER_OPPORTUNITY_ANCHOR_UNAVAILABLE');
    const applicability = resolveBrokerOpportunityApplicability({ environment: anchor.environment, provenance: anchor.provenance, captureSchemaVersion: anchor.captureSchemaVersion });
    const applicable = applicability === 'APPLICABLE_ACTIVE' || applicability === 'APPLICABLE_SUPERSEDED';
    const inserted = await tx.orderIntentBrokerPostOpportunity.create({ data: {
      orderIntentId: anchor.orderIntentId, intentCoverageId: anchor.coverageId, tradingAccountId: anchor.tradingAccountId,
      accountSubscriptionId: anchor.accountSubscriptionId, clientOrderId: anchor.clientOrderId,
      opportunitySequence: input.opportunitySequence, idempotencyKey: input.idempotencyKey,
      enrollmentGenerationId: applicable ? anchor.enrollmentGenerationId : null,
      policyRevisionId: applicable ? anchor.boundPolicyRevisionId : null,
      marketRegimeAssessmentId: anchor.marketRegimeAssessmentId, sourceSetFingerprint: anchor.sourceSetFingerprint,
      compositionCapture: anchor.marketRegimeAssessmentId ? 'EXACT' : 'NONE_VISIBLE', applicability,
      comparisonMode: 'COMPARE_ONLY', tradingEffect: 'NONE', opportunityAt: anchor.opportunityAt,
      events: { create: { sequence: 1, eventType: 'OPPORTUNITY_CAPTURED', evidenceJson: { captureVersion: 1 } } },
    } });
    return inserted;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

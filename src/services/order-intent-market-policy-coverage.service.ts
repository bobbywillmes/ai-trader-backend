import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export const ORDER_INTENT_MARKET_POLICY_COVERAGE_SCAN_MAX = 500;

type RolloutRow = {
  enabled: boolean;
  effectiveEpoch: Date | null;
  disabledAt: Date | null;
};

type IntentIdentityRow = {
  id: number;
  tradingAccountId: number;
  accountSubscriptionId: number;
};

export async function detectOrderIntentMarketPolicyCoverageGaps(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > ORDER_INTENT_MARKET_POLICY_COVERAGE_SCAN_MAX) {
    throw new RangeError(`Coverage scan limit must be between 1 and ${ORDER_INTENT_MARKET_POLICY_COVERAGE_SCAN_MAX}.`);
  }

  return prisma.$transaction(async tx => {
    const [state] = await tx.$queryRaw<Array<{ lastOrderIntentId: number }>>`
      SELECT "lastOrderIntentId"
      FROM "OrderIntentMarketPolicyCoverageScannerState"
      WHERE id = 1
      FOR UPDATE
    `;
    const [rollout] = await tx.$queryRaw<RolloutRow[]>`
      SELECT enabled, "effectiveEpoch", "disabledAt"
      FROM "OrderIntentMarketPolicyCaptureRollout"
      WHERE id = 1
    `;

    if (!state || !rollout?.effectiveEpoch) {
      return { scanned: 0, captureUnknown: 0, lastOrderIntentId: state?.lastOrderIntentId ?? 0, rolloutEnabled: rollout?.enabled ?? false };
    }

    const rows = await tx.$queryRaw<IntentIdentityRow[]>(Prisma.sql`
      SELECT oi.id, oi."tradingAccountId", oi."tradingAccountSubscriptionId" AS "accountSubscriptionId"
      FROM "OrderIntent" oi
      WHERE oi.id > ${state.lastOrderIntentId}
        AND lower(oi.side) = 'buy'
        AND oi."tradingAccountId" IS NOT NULL
        AND oi."tradingAccountSubscriptionId" IS NOT NULL
        AND oi."createdAt" >= ${rollout.effectiveEpoch}
        AND oi."createdAt" <= COALESCE(${rollout.disabledAt}, statement_timestamp())
      ORDER BY oi.id
      LIMIT ${limit}
    `);

    let captureUnknown = 0;
    for (const row of rows) {
      const inserted = await tx.$executeRaw`
        INSERT INTO "OrderIntentMarketPolicyCoverage" (
          "orderIntentId", "tradingAccountId", "accountSubscriptionId", "enrollmentGenerationId",
          "boundPolicyRevisionId", "activePolicyRevisionId", provenance, "comparisonMode", "tradingEffect", "capturedAt"
        ) VALUES (
          ${row.id}, ${row.tradingAccountId}, ${row.accountSubscriptionId}, NULL,
          NULL, NULL, 'CAPTURE_UNKNOWN'::"OrderIntentMarketPolicyCoverageProvenance", 'COMPARE_ONLY', 'NONE', statement_timestamp()
        )
        ON CONFLICT ("orderIntentId") DO NOTHING
      `;
      captureUnknown += inserted;
    }

    const lastOrderIntentId = rows.at(-1)?.id ?? state.lastOrderIntentId;
    await tx.$executeRaw`
      UPDATE "OrderIntentMarketPolicyCoverageScannerState"
      SET "lastOrderIntentId" = ${lastOrderIntentId}, "lastScannedAt" = statement_timestamp(), "updatedAt" = statement_timestamp()
      WHERE id = 1
    `;

    return { scanned: rows.length, captureUnknown, lastOrderIntentId, rolloutEnabled: rollout.enabled };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

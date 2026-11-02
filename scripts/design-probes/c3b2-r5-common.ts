// Shared helpers for the revision-5 real-schema probes (used by c3b2-r5-real-schema-probes.ts and c3b2-r5-upgrade-probes.ts).
// DISPOSABLE SERVERS ONLY. Nothing here contacts a broker.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type pg from 'pg';

export type Outcome = { ok: boolean; code?: string; message?: string; rows?: any[] };
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const attempt = async (c: pg.Client, sql: string, params: unknown[] = []): Promise<Outcome> => {
  try { const r = await c.query(sql, params); return { ok: true, rows: r.rows }; } catch (e: any) { return { ok: false, code: e.code, message: String(e.message).slice(0, 160) }; }
};
export const pidOf = (c: pg.Client) => (c as unknown as { processID: number }).processID;

/**
 * Market Intelligence side of a TradingView graph. A REAL Market Intelligence policy, enrollment and enforcement authorization are
 * created through the production services. The ALLOWED decision and its frozen obligation are then seeded with triggers disabled for
 * the INSERT ONLY (the repository's own C3A tests do the same): the real prepareObligatedBrokerDecision chain is NOT exercised here
 * and stays a proof obligation (document section 11.2). Every consumption, fence, release and guard that follows runs with ALL
 * production triggers enabled. The seeded obligation row is real data the replaced guard must match (the revision-4 harness cited a
 * literal obligation id and no row).
 */
export async function makeMarketIntelligence(args: { db: pg.Client; paperId: number; ownerId: number; strategyId: number }) {
  const { db, paperId, ownerId, strategyId } = args;
  const policy = await import('../../src/services/strategy-market-policy.service.js');
  const enrollment = await import('../../src/services/assignment-market-policy-enrollment.service.js');
  const enforcement = await import('../../src/services/assignment-market-policy-enforcement-authorization.service.js');
  const created = await policy.createStrategyMarketPolicy(strategyId, ownerId, 'R5 probe policy');
  const draft = created.revisions[0]!;
  const saved = await policy.saveStrategyMarketPolicyRevision(strategyId, draft.id, {
    expectedConfigurationFingerprint: draft.configurationFingerprint,
    rules: draft.dimensionRules.map((rule: any) => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })),
  }, ownerId);
  await policy.activateStrategyMarketPolicyRevision(strategyId, saved.id, saved.configurationFingerprint, ownerId);
  const mi = {
    enroll: async (assignmentId: number) => {
      const prepared = await enrollment.prepareAssignmentMarketPolicyEnrollment(paperId, assignmentId, ownerId);
      return enrollment.activateAssignmentMarketPolicyEnrollment(paperId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
    },
    grant: (assignmentId: number, generation: any) => enforcement.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'R5 probe' }, ownerId),
    revoke: (assignmentId: number, authorizationId: number) => enforcement.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { authorizationId, reason: 'R5 probe' }, ownerId),
  };
  const assignmentOf = async (intentId: number) => (await db.query(`SELECT "tradingAccountSubscriptionId" AS id FROM "OrderIntent" WHERE id=$1`, [intentId])).rows[0].id as number;
  const authorizationOf = new Map<number, number>();
  let seq = 0;

  /** Seeds (triggers off for the INSERTs only) a frozen obligation and one ALLOWED decision citing it. */
  async function decided(g: { intentId: number; clientOrderId: string }, options: { dispatchSequence?: number; expiresInSeconds?: number; reuseObligation?: boolean } = {}) {
    const assignmentId = await assignmentOf(g.intentId);
    let authorizationId = authorizationOf.get(g.intentId);
    if (authorizationId === undefined) {
      const generation = await mi.enroll(assignmentId);
      authorizationId = ((await mi.grant(assignmentId, generation)) as any).id as number;
      authorizationOf.set(g.intentId, authorizationId);
    }
    const a = (await db.query(`SELECT "authorizationFingerprint" AS fp, "policyRevisionId" AS rev, "enrollmentGenerationId" AS gen, "securityId", "securitySymbol", "strategyId", "subscriptionId" FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [authorizationId])).rows[0];
    const rollout = (await db.query(`SELECT enabled, version FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1`)).rows[0];
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL session_replication_role='replica'`);
      let obligationId = (await db.query(`SELECT id FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [g.intentId])).rows[0]?.id as number | undefined;
      if (obligationId === undefined) {
        obligationId = (await db.query(`INSERT INTO "OrderIntentMarketPolicyEnforcementObligation" ("orderIntentId","admissionAttemptId","obligationVersion",environment,"tradingAccountId","accountSubscriptionId","subscriptionId","securityId","securitySymbol","strategyId","policyRevisionId","enrollmentGenerationId","authorizationId","authorizationFingerprint","authorityVersion","admissionVersion","evaluatorVersion","marketRegimeAssessmentId","compositionSourceSetFingerprint","evaluatedAt","validUntil","rolloutVersion","frozenContextJson")
          VALUES ($1,$2,'MARKET_POLICY_ENTRY_OBLIGATION_V1','PAPER',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PAPER_MARKET_POLICY_ENFORCEMENT_V2','R5_PROBE','STRATEGY_MARKET_ELIGIBILITY_V1',1,repeat('c',64),clock_timestamp(),clock_timestamp() + interval '900 seconds',$13,'{}') RETURNING id`,
          [g.intentId, 9_000_000 + g.intentId, paperId, assignmentId, a.subscriptionId, a.securityId, a.securitySymbol, a.strategyId, a.rev, a.gen, authorizationId, a.fp, rollout.version])).rows[0].id as number;
      }
      const decisionId = (await db.query(`INSERT INTO "MarketPolicyBrokerDispatchDecision" ("decisionKey","decisionVersion",authority,"orderIntentId","dispatchSequence","clientOrderId",environment,"tradingAccountId","accountSubscriptionId","subscriptionId","securityId","securitySymbol","strategyId","policyRevisionId","enrollmentGenerationId","authorizationId","authorizationFingerprint","rolloutEnabled","rolloutVersion","evaluatedAt","validUntil","dispatchExpiresAt","evaluatorVersion","marketRegimeAssessmentId","compositionVersion","compositionSourceSetFingerprint","compositionEvidenceHealth","obligationId","authorityVersion",outcome,"reasonCode","dispatchDisposition","evidenceJson","createdAt")
        VALUES ($1,'MARKET_POLICY_BROKER_TIME_ENFORCEMENT_V1','AUTHORITATIVE',$2,$3,$4,'PAPER',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,clock_timestamp(),clock_timestamp() + interval '900 seconds',clock_timestamp() + make_interval(secs => $18::int),'STRATEGY_MARKET_ELIGIBILITY_V1',1,'MARKET_REGIME_COMPOSITION_V1',repeat('c',64),'COMPLETE',$17,'PAPER_MARKET_POLICY_ENFORCEMENT_V2','ALLOWED','R5_PROBE_ALLOWED','DISPATCH_AUTHORIZED','{}',clock_timestamp()) RETURNING id`,
        [`r5-${g.intentId}-${(seq += 1)}-${Date.now()}`, g.intentId, options.dispatchSequence ?? 1, g.clientOrderId, paperId, assignmentId, a.subscriptionId, a.securityId, a.securitySymbol, a.strategyId, a.rev, a.gen, authorizationId, a.fp, rollout.enabled, rollout.version, obligationId, options.expiresInSeconds ?? 600])).rows[0].id as number;
      await db.query('COMMIT');
      return { decisionId, obligationId, authorizationId };
    } catch (error) { await db.query('ROLLBACK'); throw error; }
  }
  return { mi, decided, assignmentOf, authorizationOf };
}

/** Canonical lock acquisition for F (section 6.5, rows 1 to 23), one single-table statement per relation. Returns nothing; the fence (row 24) is separate. */
export async function canonicalLocks(db: pg.Client, c: pg.Client, g: { intentId: number }, miAuthorizationId: number) {
  const ids = (await db.query(`SELECT o."entrySignalId", o."sourceCycleId", o."accountCycleId", o."rolloutGenerationId", o."authorizationId", i."tradingAccountId" AS acct, i."tradingAccountSubscriptionId" AS tas,
      i."subscriptionId" AS sub, s."strategyId", s."exitProfileId", s."securityId", t."allocationId", sg."signalSourceId" AS src, sg."strategySignalBindingId" AS bnd, sg."strategySignalRevisionId" AS rev
    FROM "OrderIntent" i JOIN "ExternalSignalEntryExecutionObligation" o ON o."orderIntentId"=i.id JOIN "Subscription" s ON s.id=i."subscriptionId"
    JOIN "TradingAccountSubscription" t ON t.id=i."tradingAccountSubscriptionId" JOIN "Signal" sg ON sg.id=o."entrySignalId" WHERE i.id=$1`, [g.intentId])).rows[0];
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  await q(`SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`);
  await q('SELECT id FROM "ExternalSignalExecutionRolloutState" WHERE id=1 FOR UPDATE');
  await q('SELECT id FROM "ExternalSignalBrokerDispatchState" WHERE id=1 FOR UPDATE');
  await q('SELECT id FROM "ExternalSignalSource" WHERE id=$1 FOR SHARE', [ids.src]);
  await q('SELECT id FROM "StrategySignalBinding" WHERE id=$1 FOR SHARE', [ids.bnd]);
  await q('SELECT id FROM "StrategySignalRevision" WHERE id=$1 FOR SHARE', [ids.rev]);
  await q('SELECT id FROM "ExternalSignalExecutionRolloutGeneration" WHERE id=$1 FOR SHARE', [ids.rolloutGenerationId]);
  await q('SELECT id FROM "ExternalSignalTradeCycle" WHERE id=$1 FOR SHARE', [ids.sourceCycleId]);
  await q('SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=$1 FOR SHARE', [ids.accountCycleId]);
  await q('SELECT id FROM "TradingAccount" WHERE id=$1 FOR SHARE', [ids.acct]);
  await q('SELECT id FROM "TradingAccountSubscription" WHERE id=$1 FOR SHARE', [ids.tas]);
  await q('SELECT id FROM "Subscription" WHERE id=$1 FOR SHARE', [ids.sub]);
  await q('SELECT id FROM "Strategy" WHERE id=$1 FOR SHARE', [ids.strategyId]);
  await q('SELECT id FROM "ExitProfile" WHERE id=$1 FOR SHARE', [ids.exitProfileId]);
  await q('SELECT id FROM "Security" WHERE id=$1 FOR SHARE', [ids.securityId]);
  if (ids.allocationId != null) await q('SELECT id FROM "TradingAccountAllocation" WHERE id=$1 FOR SHARE', [ids.allocationId]);
  await q('SELECT id FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=$1 FOR UPDATE', [ids.authorizationId]);
  await q('SELECT id FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1 FOR SHARE');
  await q('SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1 FOR SHARE', [miAuthorizationId]);
  await q(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`entry-exposure:${ids.acct}:${ids.securityId}`]);
  await q('SELECT id FROM "OrderIntent" WHERE id=$1 FOR UPDATE', [g.intentId]);
  await q('SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]);
}

export const lockFence = (c: pg.Client, intentId: number) => c.query('SELECT version::int AS v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE', [intentId]).then(r => r.rows[0].v as number);
export const plainFence = (c: pg.Client, intentId: number) => c.query('SELECT version::int AS v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [intentId]).then(r => r.rows[0]?.v as number | undefined);

export const brokerOrderSql = `INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","createdAt","updatedAt","tradingAccountId","securityId") VALUES ($1,'alpaca',$2,$3,$4,'buy','new','{}',now(),now(),$5,$6) RETURNING id`;
export const activitySql = `INSERT INTO "BrokerActivity" (broker,mode,"activityId","activityType","activityCategory",symbol,side,qty,"cumQty","leavesQty",price,"netAmount","orderId","orderIntentId","brokerOrderRecordId","transactionTime","rawBrokerJson","createdAt","updatedAt","tradingAccountId") VALUES ('alpaca',$6,$1,'FILL','FILL',$7,'buy',1,1,0,1,1,$2,$3,$4,now(),'{}',now(),now(),$5) RETURNING id`;

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

// Phase 4A.2C3B.2-1: the COMPLETE database consumption guard, the canonical lock prelude, the post-pair fence bump and the receipt clock,
// exercised against real Market Intelligence obligations and decisions (real admission, real worker claim, real decision preparation).
// The guard is INERT infrastructure: there is no production writer. Each pair below is written by raw SQL exactly as the future
// finalization transaction will write it. The broker transport is a failing spy; no test can reach a broker.

vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async () => ({ allowed: true, statusCode: 200, reason: 'allowed', details: { rule: 'c3b2-1' } })),
  logRiskGateBlockedOrder: vi.fn(async () => undefined),
}));
vi.mock('../../services/assignment-entry-evaluation.service.js', () => ({
  evaluateAssignmentEntry: vi.fn(async ({ input }: { input: { tradingAccountSubscriptionId: number } }) => {
    const { prisma } = await import('../prisma.js');
    const assignment = await prisma.tradingAccountSubscription.findUniqueOrThrow({ where: { id: input.tradingAccountSubscriptionId }, include: { subscription: true } });
    return {
      input: { tradingAccountId: assignment.tradingAccountId, tradingAccountSubscriptionId: assignment.id, subscriptionId: assignment.subscriptionId,
        subscriptionKey: assignment.subscription.key, symbol: assignment.subscription.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', extendedHours: false, signalType: 'entry', qty: 1 },
      sizing: { tradingAccountSubscriptionId: assignment.id, qty: 1, estimatedNotional: 100, snapshot: {} },
      risk: { allowed: true, statusCode: 200, reason: 'allowed', details: {} }, blockers: [], outcomeCode: 'ENTRY_ELIGIBLE',
    };
  }),
}));

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const codeOf = (error: unknown) => (error as { code?: string } | null)?.code;

type Ready = { intentId: number; claimId: number; accountCycleId: number; obligationId: number; clientOrderId: string; signalId: number; workerClaimId: number; decisionId: number;
  target: { assignmentId: number; securityId: number; subscriptionId: number; symbol: string; authorizationId: number }; mi: { generationId: number; authorizationId: number } };
type Pair = { ok: true; before: number; afterMi: number; after: number; consumedFence: number } | { ok: false; error: unknown };

(enabled ? describe : describe.skip)('TradingView C3B.2-1 complete consumption guard with real Market Intelligence (PostgreSQL)', () => {
  const fetchSpy = vi.fn(async () => { throw new Error('C3B.2-1 tests forbid broker network access'); });
  let disposable: DisposablePostgresDatabase;
  let db: Client, observer: Client;
  let fx: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
  let paperId: number, ownerId: number;
  let svc: {
    authority: typeof import('../../services/external-signal-execution-authority.service.js');
    enforcement: typeof import('../../services/assignment-market-policy-enforcement-authorization.service.js');
    enrollment: typeof import('../../services/assignment-market-policy-enrollment.service.js');
    worker: typeof import('../../services/external-signal-broker-worker.service.js');
    admission: typeof import('../../services/external-signal-entry-admission.service.js');
    dispatch: typeof import('../../services/market-policy-broker-dispatch.service.js');
    ingestion: typeof import('../../services/external-signal-ingestion.service.js');
    prisma: (typeof import('../prisma.js'))['prisma'];
  };
  const open: Client[] = [];
  const connect = async () => { const client = new Client({ connectionString: disposable.url }); await client.connect(); open.push(client); return client; };

  async function waiters() { return (await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n as number; }
  async function untilWaiters(count: number, label: string) {
    for (let i = 0; i < 800; i += 1) { if (await waiters() >= count) return; await sleep(10); }
    throw new Error(`interleaving not reached (${label}): expected ${count} lock waiters, saw ${await waiters()}`);
  }
  let lastDeadlocks = 0;
  async function newDeadlocks() {
    await sleep(1700);
    const total = (await observer.query(`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()`)).rows[0].n as number;
    const delta = total - lastDeadlocks; lastDeadlocks = total; return delta;
  }

  // ---- fixtures -------------------------------------------------------------------------------------------
  const miEnroll = async (assignmentId: number) => {
    const prepared = await svc.enrollment.prepareAssignmentMarketPolicyEnrollment(paperId, assignmentId, ownerId);
    return svc.enrollment.activateAssignmentMarketPolicyEnrollment(paperId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
  };
  const miGrant = (assignmentId: number, generation: { id: number; configurationFingerprint: string; policyRevisionId: number }) =>
    svc.enforcement.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'C3B.2-1 guard' }, ownerId);
  const cleanProspectives = () => db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='BLOCKED' WHERE status='ENTRY_EXECUTION_PROSPECTIVE'`);
  const restoreAccount = () => db.query(`UPDATE "TradingAccount" SET status='ACTIVE',"tradingEnabled"=true,"killSwitchEnabled"=false,"tradingBlocked"=false WHERE id=$1`, [paperId]);

  /** A real, MI-obligated marked intent: real admission, real worker claim, stranded 'submitting', and (optionally) a real MI decision. */
  async function ready(rawLabel: string, options: { decision?: boolean } = {}): Promise<Ready> {
    const label = rawLabel.replace(/[^a-z0-9-]+/gi, '-');
    await cleanProspectives();
    const target = await fx.createTarget();
    const generation = await miEnroll(target.assignmentId);
    const authorization = await miGrant(target.assignmentId, generation);
    const graph = await fx.prospective(label, target);
    await svc.admission.processProspectiveTradingViewEntries({ db: svc.prisma, limit: 50 });
    const cycle = (await db.query(`SELECT status::text, "entryOrderIntentId" FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [graph.accountCycleId])).rows[0];
    expect(cycle.status, `${label}: real admission must create the marked intent`).toBe('ENTRY_INTENT_CREATED');
    const intentId = cycle.entryOrderIntentId as number;
    const claimId = (await db.query(`SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [intentId])).rows[0].id as number;
    const obligation = (await db.query(`SELECT id, "clientOrderId" FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1`, [intentId])).rows[0];
    expect((await db.query(`SELECT count(*)::int n FROM "OrderIntentMarketPolicyEnforcementObligation" WHERE "orderIntentId"=$1`, [intentId])).rows[0].n, 'a frozen Market Intelligence obligation').toBe(1);
    const base = { intentId, claimId, accountCycleId: graph.accountCycleId, obligationId: obligation.id as number, clientOrderId: obligation.clientOrderId as string };
    const workerClaimId = await fx.workerClaim({ ...base, target, cycleId: graph.cycleId, signalId: graph.signalId, routeId: graph.routeId, siblingAccountCycleId: null });
    const result: Ready = { ...base, signalId: graph.signalId, workerClaimId, decisionId: 0, target, mi: { generationId: generation.id, authorizationId: authorization.id } };
    if (options.decision !== false) await decide(result);
    return result;
  }
  async function decide(g: Ready) {
    const obligation = await svc.prisma.orderIntentMarketPolicyEnforcementObligation.findUniqueOrThrow({ where: { orderIntentId: g.intentId } });
    const prepared = await svc.dispatch.prepareObligatedBrokerDecision(svc.prisma, { orderIntentId: g.intentId, tradingAccountId: paperId, symbol: g.target.symbol, clientOrderId: g.clientOrderId }, obligation.id);
    g.decisionId = prepared.decisionId;
    return g.decisionId;
  }

  const tvInsertSql = (extraColumns: string[], extraValues: string[]) => `INSERT INTO "ExternalSignalBrokerDispatchConsumption" ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId","rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId","fenceVersion","evidenceJson"${extraColumns.map(c => `,"${c}"`).join('')})
    SELECT o."orderIntentId", o.id, wc.id, $2, o."rolloutGenerationId", o."authorizationId", wc."dispatchStateVersion", o."clientOrderId", $3, '{}'${extraValues.map(v => `,${v}`).join('')}
    FROM "ExternalSignalEntryExecutionObligation" o JOIN "ExternalSignalBrokerWorkerClaim" wc ON wc."orderIntentId"=o."orderIntentId" WHERE o."orderIntentId"=$1`;

  /** The finalization protocol in raw SQL: MI consumption, fence read under lock, TradingView consumption with the validated version. */
  async function attemptPair(g: Ready, options: { isolation?: 'READ COMMITTED' | 'SERIALIZABLE'; fenceVersion?: 'current' | number | null; client?: Client; decisionId?: number;
    supplied?: Array<[column: string, sql: string]>; zone?: string; commit?: boolean; between?: (c: Client) => Promise<void> } = {}): Promise<Pair> {
    const client = options.client ?? await connect();
    try {
      if (options.zone) await client.query(`SET TIME ZONE '${options.zone}'`);
      await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? 'READ COMMITTED'}`);
      if (options.isolation === 'SERIALIZABLE') await client.query(`SELECT 1 FROM "OrderIntent" WHERE id=$1`, [g.intentId]); // take the snapshot now
      const mi = (await client.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}') RETURNING id`, [options.decisionId ?? g.decisionId, g.intentId, g.clientOrderId])).rows[0].id as number;
      if (options.between) await options.between(client);
      const fence = async () => Number((await client.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE`, [g.intentId])).rows[0].version);
      const before = await fence();
      const afterMi = await fence();
      const supplied = options.fenceVersion === undefined || options.fenceVersion === 'current' ? before : options.fenceVersion;
      await client.query(tvInsertSql((options.supplied ?? []).map(([c]) => c), (options.supplied ?? []).map(([, v]) => v)), [g.intentId, mi, supplied]);
      const consumedFence = Number((await client.query(`SELECT "fenceVersion" FROM "ExternalSignalBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [g.intentId])).rows[0].fenceVersion);
      const after = await fence();
      if (options.commit === false) { await client.query('ROLLBACK'); return { ok: true, before, afterMi, after, consumedFence }; }
      await client.query('COMMIT');
      return { ok: true, before, afterMi, after, consumedFence };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return { ok: false, error };
    } finally {
      if (options.zone) await client.query(`SET TIME ZONE 'UTC'`).catch(() => undefined);
      if (!options.client) await client.query('ROLLBACK').catch(() => undefined);
    }
  }
  const counts = async (intentId: number) => (await db.query(`SELECT (SELECT count(*)::int FROM "ExternalSignalBrokerDispatchConsumption" WHERE "orderIntentId"=$1) AS tv, (SELECT count(*)::int FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1) AS mi`, [intentId])).rows[0] as { tv: number; mi: number };
  const fenceNow = async (intentId: number) => Number((await db.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [intentId])).rows[0].version);
  const refused = async (g: Ready, pair: Pair, pattern: RegExp) => {
    expect(pair.ok, `${g.intentId}: the pair must be refused`).toBe(false);
    if (!pair.ok) expect(message(pair.error)).toMatch(pattern);
    expect(await counts(g.intentId)).toEqual({ tv: 0, mi: 0 });
  };
  const quarantineOff = async <T>(body: () => Promise<T>) => {
    await db.query(`ALTER TABLE "BrokerOrder" DISABLE TRIGGER "BrokerOrder_external_signal_quarantine"`);
    await db.query(`ALTER TABLE "BrokerActivity" DISABLE TRIGGER "BrokerActivity_external_signal_quarantine"`);
    try { return await body(); } finally {
      await db.query(`ALTER TABLE "BrokerOrder" ENABLE TRIGGER "BrokerOrder_external_signal_quarantine"`);
      await db.query(`ALTER TABLE "BrokerActivity" ENABLE TRIGGER "BrokerActivity_external_signal_quarantine"`);
    }
  };
  const brokerOrderFor = (c: Client, intentId: number, clientOrderId: string, securityId: number, brokerOrderId = `BO-${randomUUID()}`) =>
    c.query(`INSERT INTO "BrokerOrder" ("orderIntentId","tradingAccountId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","updatedAt","securityId") VALUES ($1,$2,'alpaca',$3,$4,'TVX','buy','accepted','{}',now(),$5) RETURNING id`, [intentId, paperId, brokerOrderId, clientOrderId, securityId]);

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'c3b21g');
    await disposable.migrate();
    process.env.DATABASE_URL = disposable.url;
    db = await connect(); observer = await connect();
    fx = await createTradingViewGraphFixture(db);
    ({ paperId, ownerId } = fx);
    svc = {
      authority: await import('../../services/external-signal-execution-authority.service.js'),
      enforcement: await import('../../services/assignment-market-policy-enforcement-authorization.service.js'),
      enrollment: await import('../../services/assignment-market-policy-enrollment.service.js'),
      worker: await import('../../services/external-signal-broker-worker.service.js'),
      admission: await import('../../services/external-signal-entry-admission.service.js'),
      dispatch: await import('../../services/market-policy-broker-dispatch.service.js'),
      ingestion: await import('../../services/external-signal-ingestion.service.js'),
      prisma: (await import('../prisma.js')).prisma,
    };
    // Market Intelligence: an ACTIVE policy for the fixture strategy, the runtime rollout and a fresh regime composition.
    const policy = await import('../../services/strategy-market-policy.service.js');
    const created = await policy.createStrategyMarketPolicy(fx.strategyId, ownerId, 'C3B.2-1 policy');
    const draft = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(fx.strategyId, draft.id, {
      expectedConfigurationFingerprint: draft.configurationFingerprint,
      rules: draft.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })),
    }, ownerId);
    await policy.activateStrategyMarketPolicyRevision(fx.strategyId, saved.id, saved.configurationFingerprint, ownerId);
    await (await import('../../services/market-policy-enforcement-rollout.service.js')).setMarketPolicyEnforcementRuntimeRollout(true, { expectedVersion: 0, reason: 'C3B.2-1 acceptance' }, ownerId);
    const observedAt = new Date(); const validUntil = new Date(observedAt.getTime() + 6 * 3_600_000);
    const dimensions = [['TREND', 'TREND_V1', 'UP'], ['VOLATILITY', 'VOLATILITY_V1', 'NORMAL'], ['BREADTH', 'BREADTH_V1', 'MIXED'], ['PARTICIPATION', 'PARTICIPATION_V1', 'NORMAL'], ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', 'NORMAL']] as const;
    const sources: Array<{ dimension: string; version: string; state: string; id: number }> = [];
    for (const [dimension, version, state] of dimensions) {
      const row = await db.query(`INSERT INTO "MarketRegimeDimensionAssessment" (dimension,"algorithmVersion","evidenceSchemaVersion","targetAt","sessionDate",attempt,status,"rawState","effectiveState","dataThroughAt","validUntil","startedAt","completedAt","evidenceJson") VALUES ($1,$2,1,$3,DATE '2026-10-28',1,'VALID',$4,$4,$3,$5,$3,$3,'{}') RETURNING id`, [dimension, version, observedAt, state, validUntil]);
      sources.push({ dimension, version, state, id: row.rows[0].id });
    }
    await db.query('BEGIN');
    const compositionId = (await db.query(`INSERT INTO "MarketRegimeAssessment" ("compositionVersion","evidenceSchemaVersion","targetAt","observedAt","dataThroughAt","validUntil","publicationStatus","evidenceHealth","sourceSetFingerprint","startedAt","completedAt","evidenceJson") VALUES ('MARKET_REGIME_COMPOSITION_V1',1,$1,$1,$1,$2,'SUCCEEDED','COMPLETE',$3,$1,$1,'{}') RETURNING id`, [observedAt, validUntil, randomUUID().replaceAll('-', '').repeat(2)])).rows[0].id;
    for (const [ordinal, source] of sources.entries()) await db.query(`INSERT INTO "MarketRegimeAssessmentSource" ("marketRegimeAssessmentId",dimension,"requiredAlgorithmVersion","expectedTargetAt","sourceAssessmentId","sourceEvidenceSchemaVersion","sourceAttempt","sourceStatus","sourceTargetAt","sourceCompletedAt","sourceDataThroughAt","sourceValidUntil","sourceRawState","sourceEffectiveState",health,"reasonCode",ordinal,"evidenceJson") VALUES ($1,$2,$3,$4,$5,1,1,'VALID',$4,$4,$4,$6,$7,$7,'AVAILABLE',NULL,$8,'{}')`, [compositionId, source.dimension, source.version, observedAt, source.id, validUntil, source.state, ordinal + 1]);
    await db.query('COMMIT');
    await newDeadlocks();
  }, 300_000);

  afterEach(async () => { await restoreAccount(); });

  afterAll(async () => {
    for (const client of open) await client.query('ROLLBACK').catch(() => undefined);
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    await svc?.prisma.$disconnect();
    for (const client of open) await client.end().catch(() => undefined);
    await disposable?.drop();
    vi.unstubAllGlobals();
  });

  // =============================================================================================================
  describe('the legitimate pair', () => {
    it('uses the real test-only finalizer to commit one atomic pair and recover duplicates or a lost commit acknowledgement', async () => {
      const g = await ready('service-finalizer', { decision: false });
      const before = await fenceNow(g.intentId);
      const first = await svc.worker.finalizeTradingViewDispatch(g.intentId, {
        db: svc.prisma,
        afterCommit: async () => { throw new Error('SIMULATED_LOST_COMMIT_ACKNOWLEDGEMENT'); },
      });
      expect(first).toMatchObject({ outcome: 'ALREADY_AUTHORIZED', orderIntentId: g.intentId });
      expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 });
      // D persists a new decision (+1) and F's TradingView consumption performs the one post-pair bump (+1).
      expect(await fenceNow(g.intentId)).toBe(before + 2);
      const duplicate = await svc.worker.finalizeTradingViewDispatch(g.intentId);
      expect(duplicate).toMatchObject({ outcome: 'ALREADY_AUTHORIZED', tradingViewConsumptionId: first.tradingViewConsumptionId, marketPolicyConsumptionId: first.marketPolicyConsumptionId });
      expect(duplicate.authorizationDeadlineAt).toEqual(first.authorizationDeadlineAt);
      expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 });
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 180_000);

    it('rejects the standalone Market Intelligence entry point for a marked TradingView intent before preparing a decision', async () => {
      const g = await ready('standalone-refused', { decision: false });
      await expect(svc.dispatch.prepareEntryBrokerDispatch({ orderIntentId: g.intentId, tradingAccountId: paperId, symbol: g.target.symbol, clientOrderId: g.clientOrderId }))
        .rejects.toMatchObject({ reasonCode: 'TECHNICAL_FAILURE_TRADINGVIEW_REQUIRES_PAIRED_CONSUMPTION', deliveryClassification: 'DEFINITELY_NOT_SENT' });
      expect((await db.query(`SELECT count(*)::int n FROM "MarketPolicyBrokerDispatchDecision" WHERE "orderIntentId"=$1`, [g.intentId])).rows[0].n).toBe(1);
      expect(await counts(g.intentId)).toEqual({ tv: 0, mi: 0 });
    }, 180_000);

    it('lets exactly one competing finalizer commit and recovers the loser from the durable pair', async () => {
      const g = await ready('service-competing', { decision: false });
      const settled = await Promise.allSettled([
        svc.worker.finalizeTradingViewDispatch(g.intentId),
        svc.worker.finalizeTradingViewDispatch(g.intentId),
      ]);
      expect(settled.every(result => result.status === 'fulfilled'), settled.map(result => result.status === 'rejected' ? message(result.reason) : result.value.outcome).join(', ')).toBe(true);
      const values = settled.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof svc.worker.finalizeTradingViewDispatch>>> => result.status === 'fulfilled').map(result => result.value);
      expect(new Set(values.map(value => value.tradingViewConsumptionId)).size).toBe(1);
      expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 });
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 180_000);

    it('refuses a current account pause in F and rolls back both consumptions', async () => {
      const g = await ready('service-paused', { decision: false });
      await db.query(`UPDATE "TradingAccount" SET status='PAUSED',"tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=$1`, [paperId]);
      await expect(svc.worker.finalizeTradingViewDispatch(g.intentId)).rejects.toMatchObject({ reasonCode: 'TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE' });
      expect(await counts(g.intentId)).toEqual({ tv: 0, mi: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 180_000);

    it.each(['READ COMMITTED', 'SERIALIZABLE'] as const)('commits under %s with no caller pre-locks; fenceVersion is the validated pre-consumption version and the fence moves once, after the pair', async isolation => {
      const g = await ready(`pair-${isolation}`);
      const result = await attemptPair(g, { isolation });
      expect(result.ok, result.ok ? '' : message(result.error)).toBe(true);
      if (!result.ok) return;
      // The Market Intelligence consumption is deliberately not fenced: the version F read is unchanged by it.
      expect(result.afterMi).toBe(result.before);
      expect(result.consumedFence).toBe(result.before);
      expect(result.after).toBe(result.before + 1);
      expect(await fenceNow(g.intentId)).toBe(result.before + 1);
      expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 });
      const row = (await db.query(`SELECT c."authorizedAt", c."authorizationDeadlineAt", s."receivedAt", c."consumedAt" FROM "ExternalSignalBrokerDispatchConsumption" c JOIN "ExternalSignalEntryExecutionObligation" o ON o.id=c."executionObligationId" JOIN "Signal" s ON s.id=o."entrySignalId" WHERE c."orderIntentId"=$1`, [g.intentId])).rows[0];
      expect(row.authorizationDeadlineAt.getTime()).toBeLessThanOrEqual(row.authorizedAt.getTime() + 30_000);
      expect(row.authorizationDeadlineAt.getTime()).toBeLessThanOrEqual(row.receivedAt.getTime() + 120_000);
      expect(row.authorizationDeadlineAt.getTime()).toBeGreaterThan(row.authorizedAt.getTime());
    }, 120_000);

    it('leaves the fence at v and no row anywhere when the pair is rolled back, and a retry then succeeds at v+1', async () => {
      const g = await ready('pair-rollback');
      const v = await fenceNow(g.intentId);
      const first = await attemptPair(g, { commit: false });
      expect(first.ok).toBe(true);
      expect(await fenceNow(g.intentId)).toBe(v);
      expect(await counts(g.intentId)).toEqual({ tv: 0, mi: 0 });
      const retry = await attemptPair(g);
      expect(retry.ok, retry.ok ? '' : message(retry.error)).toBe(true);
      expect(await fenceNow(g.intentId)).toBe(v + 1);
    }, 120_000);

    it('rejects a stale, advanced or NULL fenceVersion, and caller-supplied authorizedAt / authorizationDeadlineAt', async () => {
      const g = await ready('pair-fence-values');
      const v = await fenceNow(g.intentId);
      for (const wrong of [v - 1, v + 1, null]) await refused(g, await attemptPair(g, { fenceVersion: wrong }), /fence version is stale or missing/);
      await refused(g, await attemptPair(g, { supplied: [['authorizedAt', 'now()']] }), /database-stamped and cannot be supplied/);
      await refused(g, await attemptPair(g, { supplied: [['authorizationDeadlineAt', `now() + interval '1 hour'`]] }), /database-stamped and cannot be supplied/);
      expect(await fenceNow(g.intentId)).toBe(v);
      const ok = await attemptPair(g);
      expect(ok.ok, ok.ok ? '' : message(ok.error)).toBe(true);
    }, 120_000);

    it('rejects a second pair for the same intent and makes the stored pair immutable', async () => {
      const g = await ready('pair-once');
      expect((await attemptPair(g)).ok).toBe(true);
      const again = await attemptPair(g);
      expect(again.ok).toBe(false);
      for (const sql of [`UPDATE "ExternalSignalBrokerDispatchConsumption" SET "fenceVersion"=1 WHERE "orderIntentId"=$1`, `UPDATE "ExternalSignalBrokerDispatchConsumption" SET "authorizationDeadlineAt"=now() + interval '1 day' WHERE "orderIntentId"=$1`, `DELETE FROM "ExternalSignalBrokerDispatchConsumption" WHERE "orderIntentId"=$1`]) {
        await expect(db.query(sql, [g.intentId])).rejects.toThrow(/immutable/);
      }
    }, 120_000);

    it('produces no broker call, BrokerOrder or BrokerActivity', async () => {
      const g = await ready('pair-no-broker');
      expect((await attemptPair(g)).ok).toBe(true);
      expect((await db.query(`SELECT (SELECT count(*)::int FROM "BrokerOrder" WHERE "orderIntentId"=$1) o, (SELECT count(*)::int FROM "BrokerActivity" WHERE "orderIntentId"=$1) a`, [g.intentId])).rows[0]).toEqual({ o: 0, a: 0 });
      expect(fetchSpy).not.toHaveBeenCalled();
    }, 120_000);

    it('does not bump the fence for a standalone Market Intelligence consumption of a marked intent (the deferred pair check refuses it at commit)', async () => {
      const g = await ready('mi-only');
      const v = await fenceNow(g.intentId);
      const client = await connect();
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}')`, [g.decisionId, g.intentId, g.clientOrderId]);
        expect(Number((await client.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [g.intentId])).rows[0].version)).toBe(v);
        await expect(client.query('COMMIT')).rejects.toThrow(/requires paired final-dispatch consumptions/);
      } finally { await client.query('ROLLBACK').catch(() => undefined); }
      expect(await fenceNow(g.intentId)).toBe(v);
    }, 120_000);
  });

  // =============================================================================================================
  describe('existing evidence is refused by the guard itself, under both isolation levels (the fence alone is necessary but not sufficient)', () => {
    type Evidence = [label: string, make: (g: Ready) => Promise<unknown>];
    const evidence: Evidence[] = [
      ['a BrokerOrder for the intent id', g => quarantineOff(() => brokerOrderFor(db, g.intentId, `other-${randomUUID()}`, g.target.securityId))],
      ['a BrokerOrder under another intent that carries the frozen clientOrderId (same account)', async g => {
        const other = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('manual','OTH','sell','market','day','received',$2,'{}',$1,now(),now()) RETURNING id`, [paperId, `oth-${randomUUID()}`])).rows[0].id as number;
        return quarantineOff(() => brokerOrderFor(db, other, g.clientOrderId, g.target.securityId));
      }],
      ['a BrokerActivity for the intent id', g => quarantineOff(() => db.query(`INSERT INTO "BrokerActivity" ("tradingAccountId","orderIntentId",broker,mode,"activityId","activityType","rawBrokerJson","updatedAt") VALUES ($1,$2,'alpaca','paper',$3,'FILL','{}',now())`, [paperId, g.intentId, `a-${randomUUID()}`]))],
      ['an ADAPTER_INVOCATION_STARTED claim event', g => db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'ADAPTER_INVOCATION_STARTED','{}')`, [g.claimId])],
      ['a DISPATCH_OUTCOME_RECORDED claim event', g => db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'DISPATCH_OUTCOME_RECORDED','{}')`, [g.claimId])],
      ['a BROKER_DELIVERY_UNCERTAIN claim event', g => db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'BROKER_DELIVERY_UNCERTAIN','{}')`, [g.claimId])],
    ];
    it.each(evidence.flatMap(([label, make]) => (['READ COMMITTED', 'SERIALIZABLE'] as const).map(isolation => [label, isolation, make] as const)))('refuses %s under %s with zero consumption rows, supplying the CURRENT fence version', async (_label, isolation, make) => {
      const g = await ready('evidence');
      await make(g);
      await refused(g, await attemptPair(g, { isolation }), /TRADINGVIEW_BROKER_EVIDENCE_EXISTS|TRADINGVIEW_CONTRADICTORY_EVIDENCE/);
    }, 120_000);
  });

  // =============================================================================================================
  describe('world state that changed before the locks (rejected by the guard or the Market Intelligence trigger, never committed)', () => {
    const control = async (statement: string, params: unknown[] = []) => {
      // Aged or removed receipts model history. The immutability guard is bypassed deliberately, as the table owner, for this one statement.
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role='replica'`);
      await db.query(statement, params);
      await db.query('COMMIT');
    };
    const cases: Array<[string, (g: Ready) => Promise<void>, RegExp]> = [
      ['the kill switch is on', async () => { await db.query(`UPDATE "TradingAccount" SET "tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=$1`, [paperId]); }, /TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE|BROKER_DISPATCH|not executable|kill/i],
      ['the account is paused', async () => { await db.query(`UPDATE "TradingAccount" SET status='PAUSED',"tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=$1`, [paperId]); }, /TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE|BROKER_DISPATCH|not executable|pause/i],
      ['trading is blocked on the account', async () => { await db.query(`UPDATE "TradingAccount" SET "tradingBlocked"=true WHERE id=$1`, [paperId]); }, /TRADINGVIEW_ACCOUNT_NOT_ELIGIBLE|BROKER_DISPATCH|not executable|blocked/i],
      ['entries are disabled on the assignment', async g => { await db.query(`UPDATE "TradingAccountSubscription" SET "entriesEnabled"=false WHERE id=$1`, [g.target.assignmentId]); }, /TRADINGVIEW_ASSIGNMENT_NOT_ELIGIBLE|BROKER_DISPATCH|not executable/i],
      ['the signal receipt is 200 seconds old', g => control(`UPDATE "Signal" SET "receivedAt" = clock_timestamp() - interval '200 seconds' WHERE id=$1`, [g.signalId]), /TRADINGVIEW_ENTRY_SIGNAL_EXPIRED/],
      ['the signal has no receipt (a historical signal)', g => control(`UPDATE "Signal" SET "receivedAt" = NULL WHERE id=$1`, [g.signalId]), /TRADINGVIEW_ENTRY_SIGNAL_EXPIRED/],
      ['the receipt has under five seconds left', g => control(`UPDATE "Signal" SET "receivedAt" = clock_timestamp() - interval '117 seconds' WHERE id=$1`, [g.signalId]), /TRADINGVIEW_ENTRY_SIGNAL_EXPIRED/],
      ['the receipt predates the dispatch activation epoch', g => control(`UPDATE "Signal" SET "receivedAt" = (SELECT "activatedAt" - interval '1 second' FROM "ExternalSignalBrokerDispatchState" WHERE id=1) WHERE id=$1`, [g.signalId]), /TRADINGVIEW_ENTRY_SIGNAL_EXPIRED|TRADINGVIEW_BEFORE_ACTIVATION_EPOCH/],
      ['the TradingView authorization was revoked', async g => { await svc.authority.revokeExternalSignalEntryExecutionAuthorization(paperId, g.target.assignmentId, g.target.authorizationId, 'C3B.2-1 revoke before consumption', ownerId); }, /TRADINGVIEW_AUTHORIZATION_NOT_EFFECTIVE|BROKER_DISPATCH|final dispatch evidence/i],
    ];
    it.each(cases)('refuses the pair when %s', async (_label, mutate, pattern) => {
      const g = await ready('world');
      await mutate(g);
      await refused(g, await attemptPair(g), pattern);
      await restoreAccount();
    }, 120_000);

    it('refuses the pair once an EXIT is accepted for the cycle', async () => {
      const g = await ready('world-exit');
      const entry = (await db.query(`SELECT * FROM "Signal" WHERE id=$1`, [g.signalId])).rows[0];
      await db.query('BEGIN');
      const exitId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash") VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,$9,'EXIT_LONG',$10,'15m',now(),$11) RETURNING id`,
        [entry.signalSourceId, entry.strategySignalBindingId, entry.strategyId, entry.securityId, `exit:${randomUUID()}`, entry.externalTradeCycleRef, randomUUID(), entry.strategySignalRevisionId, entry.externalSignalTradeCycleId, entry.symbol, 'e'.repeat(64)])).rows[0].id;
      await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [exitId]);
      await db.query('COMMIT');
      await refused(g, await attemptPair(g), /TRADINGVIEW_EXIT_ACCEPTED|BROKER_DISPATCH|not executable/i);
    }, 120_000);

    it('refuses a pair built on a superseded decision', async () => {
      const g = await ready('decision-superseded');
      const stale = g.decisionId;
      await decide(g); // a newer decision supersedes the first
      expect(g.decisionId).not.toBe(stale);
      await refused(g, await attemptPair(g, { decisionId: stale }), /TRADINGVIEW_DECISION_SUPERSEDED|BROKER_DISPATCH|decision/i);
    }, 120_000);

    it.each(['America/New_York', 'Pacific/Kiritimati', 'Asia/Kolkata'])('is independent of the session TimeZone %s: a fresh pair commits and an aged receipt is refused', async zone => {
      const fresh = await ready(`zone-${zone}-fresh`);
      const done = await attemptPair(fresh, { zone });
      expect(done.ok, done.ok ? '' : message(done.error)).toBe(true);
      const aged = await ready(`zone-${zone}-aged`);
      await control(`UPDATE "Signal" SET "receivedAt" = clock_timestamp() - interval '200 seconds' WHERE id=$1`, [aged.signalId]);
      await refused(aged, await attemptPair(aged, { zone }), /TRADINGVIEW_ENTRY_SIGNAL_EXPIRED/);
    }, 180_000);
  });

  // =============================================================================================================
  describe('fence ordering under READ COMMITTED and SERIALIZABLE', () => {
    it.each(['READ COMMITTED', 'SERIALIZABLE'] as const)('a lock-only evidence writer that commits after the finalizer starts is detected (%s): 40001 under SERIALIZABLE, the guard under READ COMMITTED', async isolation => {
      // The writer commits evidence AFTER the finalizer's snapshot and BEFORE its first lock.
      const race = await ready(`order-race-${isolation}`);
      const writer = await connect();
      await quarantineOff(async () => {
        const client = await connect();
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await client.query(`SELECT 1 FROM "OrderIntent" WHERE id=$1`, [race.intentId]); // the finalizer's snapshot
        await brokerOrderFor(writer, race.intentId, race.clientOrderId, race.target.securityId); // committed evidence, after the snapshot
        let failure: unknown = null;
        try {
          await client.query(`INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") VALUES ($1,$2,$3,'{}')`, [race.decisionId, race.intentId, race.clientOrderId]);
          const v = Number((await client.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE`, [race.intentId])).rows[0].version);
          await client.query(tvInsertSql([], []), [race.intentId, (await client.query(`SELECT id FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [race.intentId])).rows[0].id, v]);
          await client.query('COMMIT');
        } catch (error) { failure = error; await client.query('ROLLBACK').catch(() => undefined); }
        expect(failure, 'the pair must not commit next to committed broker evidence').not.toBeNull();
        if (isolation === 'SERIALIZABLE') expect(codeOf(failure) === '40001' || /could not serialize|TRADINGVIEW_BROKER_EVIDENCE_EXISTS/.test(message(failure))).toBe(true);
        else expect(message(failure)).toMatch(/TRADINGVIEW_BROKER_EVIDENCE_EXISTS|fence version is stale/);
      });
      expect(await counts(race.intentId)).toEqual({ tv: 0, mi: 0 });
    }, 180_000);

    it('a finalizer that commits first makes a stale SERIALIZABLE evidence writer fail (40001) and lets a READ COMMITTED writer record post-pair evidence at a later version', async () => {
      for (const writerIsolation of ['SERIALIZABLE', 'READ COMMITTED'] as const) {
        const g = await ready(`order-finalizer-first-${writerIsolation}`);
        const writer = await connect();
        await writer.query(`BEGIN ISOLATION LEVEL ${writerIsolation}`);
        await writer.query(`SELECT 1 FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [g.intentId]); // the writer's snapshot predates the pair
        const done = await attemptPair(g);
        expect(done.ok, done.ok ? '' : message(done.error)).toBe(true);
        const at = await fenceNow(g.intentId);
        await quarantineOff(async () => {
          let failure: unknown = null;
          try { await brokerOrderFor(writer, g.intentId, g.clientOrderId, g.target.securityId); await writer.query('COMMIT'); } catch (error) { failure = error; await writer.query('ROLLBACK').catch(() => undefined); }
          if (writerIsolation === 'SERIALIZABLE') { expect(failure).not.toBeNull(); expect(codeOf(failure) === '40001' || /could not serialize/.test(message(failure))).toBe(true); expect(await fenceNow(g.intentId)).toBe(at); }
          else { expect(failure, failure ? message(failure) : '').toBeNull(); expect(await fenceNow(g.intentId)).toBeGreaterThan(at); }
        });
        expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 });
      }
    }, 240_000);

    it.each([['the writer commits', true], ['the writer rolls back', false]])('evidence in flight when the finalizer starts: it waits at the canonical prelude; %s', async (_label, writerCommits) => {
      const g = await ready(`order-inflight-${writerCommits}`);
      const writer = await connect();
      let outcome: Pair | null = null;
      await quarantineOff(async () => {
        await writer.query('BEGIN');
        await brokerOrderFor(writer, g.intentId, g.clientOrderId, g.target.securityId); // uncommitted; its foreign key holds KEY SHARE on the intent
        const base = await waiters();
        const finalizer = attemptPair(g);
        await untilWaiters(base + 1, 'finalizer queued behind the in-flight evidence');
        await writer.query(writerCommits ? 'COMMIT' : 'ROLLBACK');
        outcome = await finalizer;
      });
      const settled = outcome as Pair | null;
      if (writerCommits) { expect(settled!.ok).toBe(false); expect(await counts(g.intentId)).toEqual({ tv: 0, mi: 0 }); }
      else { expect(settled!.ok, settled!.ok ? '' : message((settled as { error: unknown }).error)).toBe(true); expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 }); }
    }, 180_000);
  });

  // =============================================================================================================
  describe('the authorization clock is read after the locks of the guard (Hermes LOW)', () => {
    // A concurrent holder blocks the guard at a protected row (the worker claim, row 25) AFTER the guard was entered. The receipt is set so the
    // signal is still valid when the trigger starts and has less than the five-second margin left when the lock is finally granted.
    async function waitedPair(label: string, receiptAgeSeconds: number | null, holdMs: number) {
      const g = await ready(label);
      if (receiptAgeSeconds !== null) {
        await db.query('BEGIN');
        await db.query(`SET LOCAL session_replication_role='replica'`); // history: the receipt is aged deliberately, as the table owner
        await db.query(`SET LOCAL TIME ZONE 'UTC'`);
        await db.query(`UPDATE "Signal" SET "receivedAt" = clock_timestamp() - make_interval(secs => $2) WHERE id=$1`, [g.signalId, receiptAgeSeconds]);
        // The activation epochs must still precede the (now older) receipt, so that only the freshness window can refuse the pair.
        await db.query(`UPDATE "ExternalSignalBrokerDispatchState" SET "activatedAt" = least("activatedAt", clock_timestamp() - interval '600 seconds') WHERE id=1`);
        await db.query(`UPDATE "ExternalSignalEntryExecutionAuthorization" SET "authorizedAt" = least("authorizedAt", clock_timestamp() - interval '600 seconds') WHERE id=(SELECT "authorizationId" FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1)`, [g.obligationId]);
        await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET "createdAt" = least("createdAt", clock_timestamp() - interval '600 seconds') WHERE id=$1`, [g.accountCycleId]);
        await db.query('COMMIT');
      }
      const holder = await connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT id FROM "ExternalSignalBrokerWorkerClaim" WHERE id=$1 FOR NO KEY UPDATE`, [g.workerClaimId]);
      const finalizer = await connect();
      const before = await waiters();
      const entered = (await observer.query(`SELECT clock_timestamp() AS now`)).rows[0].now as Date;
      const pair = attemptPair(g, { client: finalizer });
      await untilWaiters(before + 1, 'the guard waits for the worker claim row');
      await sleep(holdMs);
      const released = (await observer.query(`SELECT clock_timestamp() AS now`)).rows[0].now as Date;
      await holder.query('ROLLBACK');
      return { g, result: await pair, entered, released };
    }

    it('refuses a signal that expired while the guard waited for a lock, although it was valid when the trigger started', async () => {
      // 112 s old on entry: 8 s remain (> 5 s margin). After a 4.5 s wait 3.5 s remain, inside the margin.
      const { g, result } = await waitedPair('clock-expired-in-wait', 112, 4500);
      await refused(g, result, /TRADINGVIEW_ENTRY_SIGNAL_EXPIRED/);
    }, 120_000);

    it('stamps authorizedAt after the wait and keeps the accepted deadline contract for a signal that is still fresh', async () => {
      const { g, result, entered, released } = await waitedPair('clock-fresh-after-wait', null, 1500);
      expect(result.ok, result.ok ? '' : message(result.error)).toBe(true);
      const row = (await db.query(`SELECT c."authorizedAt", c."authorizationDeadlineAt", s."receivedAt" FROM "ExternalSignalBrokerDispatchConsumption" c JOIN "ExternalSignalEntryExecutionObligation" o ON o.id=c."executionObligationId" JOIN "Signal" s ON s.id=o."entrySignalId" WHERE c."orderIntentId"=$1`, [g.intentId])).rows[0];
      expect(row.authorizedAt.getTime()).toBeGreaterThanOrEqual(released.getTime()); // later than the lock grant, not the trigger entry
      expect(row.authorizedAt.getTime()).toBeGreaterThan(entered.getTime() + 1000);
      expect(row.authorizationDeadlineAt.getTime()).toBe(Math.min(row.receivedAt.getTime() + 120_000, row.authorizedAt.getTime() + 30_000));
    }, 120_000);
  });

  describe('the database lock prelude versus the real Market Intelligence revoke', () => {
    async function revokeRace(options: { preludeInstalled: boolean }) {
      const g = await ready(`prelude-${options.preludeInstalled}`);
      if (!options.preludeInstalled) await db.query(`ALTER TABLE "MarketPolicyBrokerDispatchConsumption" DISABLE TRIGGER "BrokerDispatchConsumption_a_lock_prelude"`);
      try {
        const finalizer = await connect();
        let revoke: Promise<unknown> | null = null;
        // The finalizer inserts the MI consumption first (taking the MI authorization lock) and holds the transaction open; the revoke starts.
        const pair = attemptPair(g, { client: finalizer, between: async () => {
          const base = await waiters();
          revoke = svc.enforcement.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, g.target.assignmentId, { authorizationId: g.mi.authorizationId, reason: 'C3B.2-1 prelude race' }, ownerId).then(() => null, error => error);
          await untilWaiters(base + 1, 'revoke queued behind the finalizer').catch(() => undefined);
        } });
        const finalized = await pair;
        const revoked = (await (revoke as Promise<unknown> | null)) ?? null;
        return { g, finalized, revoked: revoked as unknown };
      } finally {
        if (!options.preludeInstalled) await db.query(`ALTER TABLE "MarketPolicyBrokerDispatchConsumption" ENABLE TRIGGER "BrokerDispatchConsumption_a_lock_prelude"`);
      }
    }

    it('with the prelude installed the pair commits, the revoke applies after it, and the server detects no deadlock', async () => {
      await newDeadlocks();
      const { g, finalized, revoked } = await revokeRace({ preludeInstalled: true });
      expect(finalized.ok, finalized.ok ? '' : message(finalized.error)).toBe(true);
      expect(revoked, revoked ? message(revoked) : '').toBeNull();
      expect(await counts(g.intentId)).toEqual({ tv: 1, mi: 1 });
      expect((await db.query(`SELECT status::text FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1`, [g.mi.authorizationId])).rows[0].status).toBe('REVOKED');
      expect(await newDeadlocks()).toBe(0);
    }, 180_000);

    it('negative control: without the prelude the same interleaving deadlocks (40P01), which is why the prelude lives in the database', async () => {
      await newDeadlocks();
      const { finalized, revoked } = await revokeRace({ preludeInstalled: false });
      const sawDeadlock = (!finalized.ok && codeOf(finalized.error) === '40P01') || (revoked !== null && codeOf(revoked) === '40P01') || (await newDeadlocks()) > 0;
      expect(sawDeadlock).toBe(true);
    }, 180_000);
  });

  // =============================================================================================================
  describe('receipt clock through the real services under a skewed application clock', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('admits a fresh signal whatever the application clock says (+1 hour and -1 hour), because the age is the database receipt age', async () => {
      for (const skew of [3_600_000, -3_600_000]) {
        await cleanProspectives();
        const target = await fx.createTarget();
        const generation = await miEnroll(target.assignmentId); await miGrant(target.assignmentId, generation);
        const graph = await fx.prospective(`skew-${skew}`, target);
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() + skew));
        try { await svc.admission.processProspectiveTradingViewEntries({ db: svc.prisma, limit: 50 }); } finally { vi.useRealTimers(); }
        expect((await db.query(`SELECT status::text FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [graph.accountCycleId])).rows[0].status, `application clock skew ${skew} ms`).toBe('ENTRY_INTENT_CREATED');
      }
    }, 240_000);

    it('refuses an aged or historical (NULL) receipt at admission, with the same result under any session TimeZone', async () => {
      for (const mode of ['aged', 'null'] as const) {
        await cleanProspectives();
        const target = await fx.createTarget();
        const generation = await miEnroll(target.assignmentId); await miGrant(target.assignmentId, generation);
        const graph = await fx.prospective(`stale-${mode}`, target);
        await db.query('BEGIN');
        await db.query(`SET LOCAL session_replication_role='replica'`);
        await db.query(mode === 'aged' ? `UPDATE "Signal" SET "receivedAt"=clock_timestamp() - interval '200 seconds' WHERE id=$1` : `UPDATE "Signal" SET "receivedAt"=NULL WHERE id=$1`, [graph.signalId]);
        await db.query('COMMIT');
        await svc.admission.processProspectiveTradingViewEntries({ db: svc.prisma, limit: 50 });
        expect((await db.query(`SELECT status::text, "entryOrderIntentId" FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [graph.accountCycleId])).rows[0], mode).toEqual({ status: 'BLOCKED', entryOrderIntentId: null });
      }
    }, 240_000);

    it('refuses the C2 worker claim for an aged or NULL receipt through the service and directly in SQL, and claims a fresh one', async () => {
      for (const mode of ['aged', 'null'] as const) {
        const g = await fx.admit(`claim-${mode}`);
        await db.query('BEGIN');
        await db.query(`SET LOCAL session_replication_role='replica'`);
        await db.query(mode === 'aged' ? `UPDATE "Signal" SET "receivedAt"=clock_timestamp() - interval '200 seconds' WHERE id=$1` : `UPDATE "Signal" SET "receivedAt"=NULL WHERE id=$1`, [g.signalId]);
        await db.query('COMMIT');
        await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [g.intentId]);
        await expect(db.query(`INSERT INTO "ExternalSignalBrokerWorkerClaim" ("orderIntentId","executionObligationId","accountCycleId","rolloutGenerationId","dispatchStateVersion","clientOrderId","claimFingerprint") SELECT $1,$2,$3,$4,(SELECT version FROM "ExternalSignalBrokerDispatchState" WHERE id=1),$5,$6`,
          [g.intentId, g.obligationId, g.accountCycleId, fx.executeGenerationId, g.clientOrderId, createHash('sha256').update(`${mode}${g.intentId}`).digest('hex')])).rejects.toThrow(/post-activation authority/);
        const outcome = await svc.worker.processTradingViewOrderIntentForC2(g.intentId, { db: svc.prisma });
        expect(outcome.outcome, mode).toBe('C2_DISPATCH_REFUSED');
        expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalBrokerWorkerClaim" WHERE "orderIntentId"=$1`, [g.intentId])).rows[0].n).toBe(0);
      }
    }, 240_000);

    it('stamps a real ingested signal from the database clock while the application clock is an hour behind', async () => {
      const webhook = await (await import('../../services/external-signal-config.service.js')).getExternalSignalWebhook(fx.sourceId, ownerId, svc.prisma);
      const source = await svc.prisma.externalSignalSource.findUniqueOrThrow({ where: { id: fx.sourceId } });
      const target = await fx.createTarget({ grant: false });
      const cycleRef = `skew-ingest-${randomUUID()}`;
      const body = Buffer.from(JSON.stringify({ schemaVersion: 2, externalEventId: `skew-${randomUUID()}`, externalTradeCycleRef: cycleRef, externalStrategyKey: 'tv-graph', strategyRevision: 1, event: 'ENTRY_LONG', symbol: target.symbol, timeframe: '15m', signalTime: new Date(Date.now() - 3_600_000 - 5_000).toISOString() }));
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(Date.now() - 3_600_000));
      let result: unknown;
      try {
        result = await svc.ingestion.ingestExternalSignal(source, webhook.webhookKey, { requestId: randomUUID(), receivedAt: new Date(), contentType: 'application/json', bodySizeBytes: body.length, body, rawPayloadHash: createHash('sha256').update(body).digest('hex'), tooLarge: false, validContentType: true }, svc.prisma);
      } finally { vi.useRealTimers(); }
      expect((result as { signalId?: number | null }).signalId, JSON.stringify(result)).toEqual(expect.any(Number));
      const row = (await db.query(`SELECT s."receivedAt", s."createdAt", now() AS db_now FROM "Signal" s WHERE s."externalTradeCycleRef"=$1`, [cycleRef])).rows[0];
      expect(Math.abs(row.db_now.getTime() - row.receivedAt.getTime())).toBeLessThan(60_000);
    }, 120_000);
  });
});

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';

// Phase 4A.2C3B.2-0: canonical lock order of the accepted TradingView C1/C2 paths, proved with genuine
// concurrent PostgreSQL transactions through the real services. Every scenario parks one side behind a
// "gate" (a lock held by a raw connection), starts the other side, confirms from pg_stat_activity that the
// intended wait happened, releases the gate and asserts both durable outcomes. The server's deadlock
// counter must not move: a service that silently retries 40P01 would otherwise hide an inversion.
// Run once per server: PostgreSQL 16 (the dev server) and PostgreSQL 17 (any URL on a 17 server).

vi.mock('../../services/risk-gate.service.js', () => ({
  evaluateOrderRisk: vi.fn(async () => ({ allowed: true, statusCode: 200, reason: 'allowed', details: { rule: 'lock-order' } })),
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

type Settled<T = unknown> = { ok: true; value: T } | { ok: false; error: unknown };
const settle = <T>(promise: Promise<T>): Promise<Settled<T>> => promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const detailsCode = (error: unknown) => (error as { details?: { code?: string } } | null)?.details?.code;

(enabled ? describe : describe.skip)('TradingView canonical lock order (PostgreSQL)', () => {
  const fetchSpy = vi.fn(async () => { throw new Error('Lock-order tests forbid broker network access'); });
  let disposable: DisposablePostgresDatabase;
  let url: string;
  let db: Client, observer: Client;
  let fx: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
  let paperId: number, ownerId: number, owner2Id: number;
  let svc: {
    authority: typeof import('../../services/external-signal-execution-authority.service.js');
    enforcement: typeof import('../../services/assignment-market-policy-enforcement-authorization.service.js');
    enrollment: typeof import('../../services/assignment-market-policy-enrollment.service.js');
    worker: typeof import('../../services/external-signal-broker-worker.service.js');
    admission: typeof import('../../services/external-signal-entry-admission.service.js');
    correlation: typeof import('../../services/external-signal-correlation.service.js');
    recovery: typeof import('../../services/entry-dispatch-recovery.service.js');
    entryRecovery: typeof import('../../services/external-signal-entry-recovery.service.js');
    admitEntry: typeof import('../../services/market-policy-entry-admission.service.js');
    prisma: (typeof import('../prisma.js'))['prisma'];
  };
  const open: Client[] = [];
  const held: Client[] = [];
  let lastDeadlocks = 0;
  const retries = { count: 0 };

  const connect = async () => { const client = new Client({ connectionString: url }); await client.connect(); open.push(client); return client; };

  async function waiters() {
    return (await observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n as number;
  }
  async function untilWaiters(count: number, label: string) {
    for (let i = 0; i < 600; i += 1) { if (await waiters() >= count) return; await sleep(10); }
    throw new Error(`interleaving not reached (${label}): expected ${count} lock waiters, saw ${await waiters()}`);
  }
  /** Holds the given statements' locks on a raw connection until released. */
  async function hold(statements: string[]) {
    const client = await connect();
    held.push(client);
    await client.query('BEGIN');
    for (const sql of statements) await client.query(sql);
    return { client, commit: async () => { await client.query('COMMIT'); }, rollback: async () => { await client.query('ROLLBACK'); } };
  }
  /** Deadlocks the server has detected since the previous call. Stats flush lazily, so wait before reading. */
  async function newDeadlocks() {
    await sleep(1700);
    const total = (await observer.query(`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname=current_database()`)).rows[0].n as number;
    const delta = total - lastDeadlocks; lastDeadlocks = total; return delta;
  }
  /** A genuine serialization failure is a safe retry with a fresh snapshot, never a success by itself. */
  async function retried<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await run(); } catch (error) {
        if (attempt < 3 && (detailsCode(error) === 'CONCURRENT_AUTHORITY_CHANGE' || /could not serialize|40001/.test(message(error)))) { retries.count += 1; continue; }
        throw error;
      }
    }
  }
  /** first parks at its gate (or on a held lock); second then starts; the gate opens; both outcomes are returned. */
  async function interleave(o: { gate: string[]; first: () => Promise<unknown>; second: () => Promise<unknown>; secondWaits: boolean }) {
    const gate = await hold(o.gate);
    const base = await waiters();
    const first = settle(o.first());
    await untilWaiters(base + 1, 'first side parked at its gate');
    const second = settle(o.second());
    if (o.secondWaits) await untilWaiters(base + 2, 'second side queued behind the first');
    else await sleep(400);
    await gate.commit();
    const [a, b] = await Promise.all([first, second]);
    return { a, b };
  }

  const exposureKey = (accountId: number, securityId: number) => `SELECT pg_advisory_xact_lock(hashtextextended('entry-exposure:${accountId}:${securityId}',0))`;
  const lockSecurity = (id: number) => `SELECT id FROM "Security" WHERE id=${id} FOR UPDATE`;
  const lockCycle = (id: number) => `SELECT id FROM "ExternalSignalTradeCycle" WHERE id=${id} FOR UPDATE`;
  const lockMiAuthorization = (id: number) => `SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=${id} FOR UPDATE`;

  // ---- fixtures -------------------------------------------------------------------------------------------
  type Target = Awaited<ReturnType<typeof fx.createTarget>>;
  const grantTv = (target: Pick<Target, 'assignmentId' | 'securityId'>, actor = ownerId) => retried(() => svc.authority.grantExternalSignalEntryExecutionAuthorization(paperId, target.assignmentId, {
    rolloutGenerationId: fx.executeGenerationId, strategySignalBindingId: fx.bindingId, expectedStrategySignalRevisionId: fx.revisionId,
    expectedSecurityId: target.securityId, reason: 'lock-order grant',
  }, actor));
  const miEnroll = async (assignmentId: number) => {
    const prepared = await svc.enrollment.prepareAssignmentMarketPolicyEnrollment(paperId, assignmentId, ownerId);
    return svc.enrollment.activateAssignmentMarketPolicyEnrollment(paperId, assignmentId, prepared.id, ownerId, prepared.configurationFingerprint);
  };
  const miGrant = (assignmentId: number, generation: { id: number; configurationFingerprint: string; policyRevisionId: number }) =>
    svc.enforcement.grantAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { generationId: generation.id, expectedConfigurationFingerprint: generation.configurationFingerprint, expectedPolicyRevisionId: generation.policyRevisionId, reason: 'lock-order MI grant' }, ownerId);
  const miRevoke = (assignmentId: number, authorizationId: number) =>
    svc.enforcement.revokeAssignmentMarketPolicyEnforcementAuthorization(paperId, assignmentId, { authorizationId, reason: 'lock-order MI revoke' }, ownerId);
  const miLapseResolve = (assignmentId: number, authorizationId: number) =>
    svc.enforcement.resolveAssignmentMarketPolicyEnforcementLapse(paperId, assignmentId, { authorizationId, reason: 'lock-order MI lapse resolution', confirmNonEnforced: true }, ownerId);
  /** Enrolled target with an effective MI authorization; optionally lapsed (its enrollment generation disabled). */
  async function miTarget(options: { grant?: boolean; lapse?: boolean; tvGrant?: boolean } = {}) {
    const target = await fx.createTarget({ grant: options.tvGrant ?? true });
    const generation = await miEnroll(target.assignmentId);
    const authorization = options.grant === false ? null : await miGrant(target.assignmentId, generation);
    if (options.lapse && authorization) await svc.enrollment.disableAssignmentMarketPolicyEnrollment(paperId, target.assignmentId, generation.id, ownerId, 'lock-order lapse');
    return { target, generation, authorization };
  }
  const tvAuthorizationCount = async (assignmentId: number, status = 'AUTHORIZED') => (await db.query(`SELECT count(*)::int n FROM "ExternalSignalEntryExecutionAuthorization" WHERE "tradingAccountSubscriptionId"=$1 AND status=$2`, [assignmentId, status])).rows[0].n as number;
  const miStatuses = async (assignmentId: number) => (await db.query(`SELECT status::text FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=$1 ORDER BY id`, [assignmentId])).rows.map(r => r.status as string);

  async function pendingClaimGraph(label: string) {
    const graph = await fx.admit(label.replace(/[^a-z0-9-]+/gi, '-'));
    await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
    return graph;
  }
  const exposureGate = (graph: Awaited<ReturnType<typeof pendingClaimGraph>>) => exposureKey(paperId, graph.target.securityId);
  const claimState = async (intentId: number) => (await db.query(`SELECT i.status::text, i."blockReason",
      (SELECT count(*)::int FROM "ExternalSignalBrokerWorkerClaim" wc WHERE wc."orderIntentId"=i.id) AS worker_claims,
      (SELECT count(*)::int FROM "ExternalSignalBrokerDispatchConsumption" c WHERE c."orderIntentId"=i.id) AS tv_consumptions,
      (SELECT count(*)::int FROM "BrokerOrder" b WHERE b."orderIntentId"=i.id) AS broker_orders
    FROM "OrderIntent" i WHERE i.id=$1`, [intentId])).rows[0] as { status: string; blockReason: string | null; worker_claims: number; tv_consumptions: number; broker_orders: number };
  const restoreAccount = () => db.query(`UPDATE "TradingAccount" SET status='ACTIVE',"tradingEnabled"=true,"killSwitchEnabled"=false,"tradingBlocked"=false WHERE id=$1`, [paperId]);
  const cleanProspectives = () => db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='BLOCKED' WHERE status='ENTRY_EXECUTION_PROSPECTIVE'`);

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'tvlock');
    await disposable.migrate(); // genuine `prisma migrate deploy`
    url = disposable.url;
    process.env.DATABASE_URL = url;
    db = await connect(); observer = await connect();
    fx = await createTradingViewGraphFixture(db);
    ({ paperId, ownerId } = fx);
    owner2Id = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('tv-lock-owner2@test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id as number;
    svc = {
      authority: await import('../../services/external-signal-execution-authority.service.js'),
      enforcement: await import('../../services/assignment-market-policy-enforcement-authorization.service.js'),
      enrollment: await import('../../services/assignment-market-policy-enrollment.service.js'),
      worker: await import('../../services/external-signal-broker-worker.service.js'),
      admission: await import('../../services/external-signal-entry-admission.service.js'),
      correlation: await import('../../services/external-signal-correlation.service.js'),
      recovery: await import('../../services/entry-dispatch-recovery.service.js'),
      entryRecovery: await import('../../services/external-signal-entry-recovery.service.js'),
      admitEntry: await import('../../services/market-policy-entry-admission.service.js'),
      prisma: (await import('../prisma.js')).prisma,
    };
    // Market Intelligence: an ACTIVE policy for the fixture strategy, the runtime rollout and a fresh composition.
    const policy = await import('../../services/strategy-market-policy.service.js');
    const created = await policy.createStrategyMarketPolicy(fx.strategyId, ownerId, 'Lock-order policy');
    const draft = created.revisions[0]!;
    const saved = await policy.saveStrategyMarketPolicyRevision(fx.strategyId, draft.id, {
      expectedConfigurationFingerprint: draft.configurationFingerprint,
      rules: draft.dimensionRules.map(rule => ({ dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.dimension === 'TREND' ? 'REQUIRED' as const : 'IGNORED' as const, allowedStates: rule.dimension === 'TREND' ? ['UP'] : [] })),
    }, ownerId);
    await policy.activateStrategyMarketPolicyRevision(fx.strategyId, saved.id, saved.configurationFingerprint, ownerId);
    await (await import('../../services/market-policy-enforcement-rollout.service.js')).setMarketPolicyEnforcementRuntimeRollout(true, { expectedVersion: 0, reason: 'Lock-order acceptance' }, ownerId);
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
  }, 240_000);

  // A failed scenario must not leave its gate open, or every later scenario would queue behind it.
  afterEach(async () => { for (const client of held.splice(0)) await client.query('ROLLBACK').catch(() => undefined); });

  afterAll(async () => {
    for (const client of open) await client.query('ROLLBACK').catch(() => undefined);
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    await svc?.prisma.$disconnect();
    for (const client of open) await client.end().catch(() => undefined);
    await disposable?.drop();
    vi.unstubAllGlobals();
  });

  // ---- 1. TradingView authorization grant against Market Intelligence ------------------------------------
  describe.each([['different owners', false], ['the same owner', true]])('TradingView authorization grant, %s', (_label, sameOwner) => {
    const tvActor = () => sameOwner ? ownerId : owner2Id;

    it.each([['TradingView first', true], ['Market Intelligence first', false]])('versus MI grant, %s', async (_o, tvFirst) => {
      const target = await fx.createTarget({ grant: false });
      const generation = await miEnroll(target.assignmentId);
      const tv = () => grantTv(target, tvActor()); const mi = () => miGrant(target.assignmentId, generation);
      const { a, b } = await interleave({ gate: [lockSecurity(target.securityId)], first: tvFirst ? tv : mi, second: tvFirst ? mi : tv, secondWaits: true });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect(await tvAuthorizationCount(target.assignmentId)).toBe(1);
      expect(await miStatuses(target.assignmentId)).toEqual(['AUTHORIZED']);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    it.each([['TradingView first', true], ['Market Intelligence first', false]])('versus MI revoke, %s', async (_o, tvFirst) => {
      const { target, authorization } = await miTarget({ tvGrant: false });
      const tv = () => grantTv(target, tvActor()); const mi = () => miRevoke(target.assignmentId, authorization!.id);
      const { a, b } = await interleave({ gate: [tvFirst ? lockSecurity(target.securityId) : lockMiAuthorization(authorization!.id)], first: tvFirst ? tv : mi, second: tvFirst ? mi : tv, secondWaits: true });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect(await tvAuthorizationCount(target.assignmentId)).toBe(1);
      expect(await miStatuses(target.assignmentId)).toEqual(['REVOKED']);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    it.each([['TradingView first', true], ['Market Intelligence first', false]])('versus MI lapse resolution, %s', async (_o, tvFirst) => {
      const { target, authorization } = await miTarget({ tvGrant: false, lapse: true });
      expect(await miStatuses(target.assignmentId)).toEqual(['INVALIDATED']);
      const tv = () => grantTv(target, tvActor()); const mi = () => miLapseResolve(target.assignmentId, authorization!.id);
      const { a, b } = await interleave({ gate: [tvFirst ? lockSecurity(target.securityId) : lockMiAuthorization(authorization!.id)], first: tvFirst ? tv : mi, second: tvFirst ? mi : tv, secondWaits: true });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect(await tvAuthorizationCount(target.assignmentId)).toBe(1);
      expect((await db.query(`SELECT count(*)::int n FROM "AssignmentMarketPolicyEnforcementLapseResolution" WHERE "authorizationId"=$1`, [authorization!.id])).rows[0].n).toBe(1);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);
  });

  it('keeps the grant owner effective for the whole authorization transaction (User FOR SHARE blocks a concurrent demotion)', async () => {
    const target = await fx.createTarget({ grant: false });
    const gate = await hold([lockSecurity(target.securityId)]);
    const grant = settle(grantTv(target, owner2Id));
    await untilWaiters(1, 'grant parked behind the Security gate');
    const demotion = settle(db.query(`UPDATE "User" SET enabled=false WHERE id=$1`, [owner2Id]));
    await untilWaiters(2, 'owner demotion queued behind the grant\'s User share lock');
    await gate.commit();
    expect(await grant).toMatchObject({ ok: true });
    expect(await demotion).toMatchObject({ ok: true });
    expect(await tvAuthorizationCount(target.assignmentId)).toBe(1);
    await db.query(`UPDATE "User" SET enabled=true WHERE id=$1`, [owner2Id]);
    // Demotion first: the grant is refused and nothing is written.
    const second = await fx.createTarget({ grant: false });
    const demoted = await hold([`UPDATE "User" SET enabled=false WHERE id=${owner2Id}`]);
    const refused = settle(grantTv(second, owner2Id));
    await untilWaiters(1, 'grant queued behind the owner demotion');
    await demoted.commit();
    const result = await refused;
    expect(result.ok).toBe(false);
    expect(await tvAuthorizationCount(second.assignmentId)).toBe(0);
    await db.query(`UPDATE "User" SET enabled=true WHERE id=$1`, [owner2Id]);
    expect(await newDeadlocks()).toBe(0);
  }, 60_000);

  // ---- 2. Worker claim -------------------------------------------------------------------------------------
  describe('worker claim', () => {
    it('versus stale admission recovery: recovery queued first, then the claim', async () => {
      const graph = await fx.admit('claim-vs-recovery');
      const far = new Date(Date.now() + 3_600_000);
      const gate = await hold([exposureGate(graph as never)]);
      const recovery = settle(svc.recovery.recoverStaleAdmissionClaimsForAccount(paperId, far));
      await untilWaiters(1, 'stale recovery parked on the exposure advisory lock');
      await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [graph.intentId]);
      const claim = settle(svc.worker.processTradingViewOrderIntentForC2(graph.intentId));
      await untilWaiters(2, 'worker claim queued on the exposure advisory lock');
      await gate.commit();
      const [r, c] = await Promise.all([recovery, claim]);
      expect(r, message((r as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect(c).toEqual({ ok: true, value: { outcome: 'C2_DISPATCH_REFUSED' } });
      const state = await claimState(graph.intentId);
      expect(state).toMatchObject({ status: 'blocked', worker_claims: 1, tv_consumptions: 0, broker_orders: 0 });
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    it('versus ordinary (unmarked) admission through the shared boundary, both queue orders', async () => {
      for (const claimFirst of [true, false]) {
        const graph = await pendingClaimGraph(`claim-vs-admission-${claimFirst}`);
        const claim = () => svc.worker.processTradingViewOrderIntentForC2(graph.intentId);
        const ordinary = () => svc.admitEntry.admitEntryOrderIntent({
          tradingAccountId: paperId, tradingAccountSubscriptionId: graph.target.assignmentId, symbol: graph.target.symbol,
          clientOrderId: `ordinary-${randomUUID()}`, ownerKey: `ordinary:${randomUUID()}`, requestSource: 'api',
          createIntent: tx => tx.orderIntent.create({ data: { source: 'api', symbol: graph.target.symbol, side: 'buy', orderType: 'market', timeInForce: 'day', status: 'received', rawRequestJson: {}, tradingAccountId: paperId, tradingAccountSubscriptionId: graph.target.assignmentId, subscriptionId: graph.target.subscriptionId } }),
        });
        const { a, b } = await interleave({ gate: [exposureGate(graph as never)], first: claimFirst ? claim : ordinary, second: claimFirst ? ordinary : claim, secondWaits: true });
        const [claimResult, ordinaryResult] = claimFirst ? [a, b] : [b, a];
        expect(claimResult).toEqual({ ok: true, value: { outcome: 'C2_DISPATCH_REFUSED' } });
        // One position per symbol: the TradingView claim owns the exposure, so ordinary admission is refused, not queued behind it.
        expect(ordinaryResult.ok, `ordinary admission outcome: ${JSON.stringify(ordinaryResult)}`).toBe(false);
        expect(await claimState(graph.intentId)).toMatchObject({ status: 'blocked', worker_claims: 1, broker_orders: 0 });
        expect(await newDeadlocks()).toBe(0);
      }
    }, 90_000);

    it.each([['claim first', true], ['refusal first', false]])('versus an unclaimed refusal, %s', async (_o, claimFirst) => {
      const graph = await pendingClaimGraph(`claim-vs-refusal-${claimFirst}`);
      await db.query(`UPDATE "TradingAccountCredential" SET status='REVOKED' WHERE "tradingAccountId"=$1`, [paperId]);
      const rolloutGate = `SELECT pg_advisory_xact_lock(hashtext('external-signal-execution-rollout')::bigint)`;
      const gate = await hold([rolloutGate]);
      // The refusal is the claim entrypoint with invalid readiness; the competing claim runs after readiness is restored.
      const refusal = () => svc.worker.processTradingViewOrderIntentForC2(graph.intentId);
      const claim = async () => { await db.query(`UPDATE "TradingAccountCredential" SET status='ACTIVE' WHERE "tradingAccountId"=$1`, [paperId]); return svc.worker.processTradingViewOrderIntentForC2(graph.intentId); };
      const base = await waiters();
      let refusalP: Promise<Settled<unknown>>, claimP: Promise<Settled<unknown>>;
      if (claimFirst) {
        await db.query(`UPDATE "TradingAccountCredential" SET status='ACTIVE' WHERE "tradingAccountId"=$1`, [paperId]);
        claimP = settle(svc.worker.processTradingViewOrderIntentForC2(graph.intentId)); await untilWaiters(base + 1, 'claim parked');
        await db.query(`UPDATE "TradingAccountCredential" SET status='REVOKED' WHERE "tradingAccountId"=$1`, [paperId]);
        refusalP = settle(refusal()); await untilWaiters(base + 2, 'refusal queued');
      } else {
        refusalP = settle(refusal()); await untilWaiters(base + 1, 'refusal parked');
        claimP = settle(claim()); await untilWaiters(base + 2, 'claim queued');
      }
      await gate.commit();
      const [r, c] = await Promise.all([refusalP, claimP]);
      await db.query(`UPDATE "TradingAccountCredential" SET status='ACTIVE' WHERE "tradingAccountId"=$1`, [paperId]);
      expect(r, message((r as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(c, message((c as { error?: unknown }).error)).toMatchObject({ ok: true });
      const state = await claimState(graph.intentId);
      expect(state.status).toBe('blocked'); expect(state.broker_orders).toBe(0); expect(state.tv_consumptions).toBe(0);
      if (claimFirst) {
        expect(state.worker_claims).toBe(1); expect((r as { value: { outcome: string } }).value.outcome).toBe('LOST_REFUSAL_RACE');
      } else {
        expect(state.worker_claims).toBe(0); expect(state.blockReason).toBe('TRADINGVIEW_C2_PRECLAIM_READINESS_REFUSED'); expect((c as { value: { outcome: string } }).value.outcome).toBe('LOST_REFUSAL_RACE');
      }
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    it('duplicate claims: exactly one claim, one ownership event and one refusal', async () => {
      const graph = await pendingClaimGraph('claim-duplicate');
      const gate = await hold([exposureGate(graph as never)]);
      const base = await waiters();
      const one = settle(svc.worker.processTradingViewOrderIntentForC2(graph.intentId));
      await untilWaiters(base + 1, 'first claim parked');
      const two = settle(svc.worker.processTradingViewOrderIntentForC2(graph.intentId));
      await untilWaiters(base + 2, 'second claim queued behind the rollout advisory lock');
      await gate.commit();
      const results = (await Promise.all([one, two])).map(r => (r as { value: { outcome: string } }).value.outcome).sort();
      expect(results).toEqual(['C2_DISPATCH_REFUSED', 'NOT_CLAIMED']);
      expect((await claimState(graph.intentId)).worker_claims).toBe(1);
      expect((await db.query(`SELECT count(*)::int n FROM "EntryExposureClaimEvent" e JOIN "EntryExposureClaim" c ON c.id=e."claimId" WHERE c."orderIntentId"=$1 AND e."eventType"='WORKER_CLAIMED_FOR_SUBMISSION'`, [graph.intentId])).rows[0].n).toBe(1);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    // The mutable identity rows are fenced FOR SHARE: a pause, kill switch or disablement is a non-key UPDATE.
    const disablements: Array<[string, (g: Awaited<ReturnType<typeof pendingClaimGraph>>) => string, (g: Awaited<ReturnType<typeof pendingClaimGraph>>) => string]> = [
      ['account pause', () => `UPDATE "TradingAccount" SET status='PAUSED',"tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=${paperId}`, () => ''],
      ['account kill switch', () => `UPDATE "TradingAccount" SET "tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=${paperId}`, () => ''],
      ['assignment disablement', g => `UPDATE "TradingAccountSubscription" SET enabled=false WHERE id=${g.target.assignmentId}`, () => ''],
      ['entries disablement', g => `UPDATE "TradingAccountSubscription" SET "entriesEnabled"=false WHERE id=${g.target.assignmentId}`, () => ''],
      ['Subscription disablement', g => `UPDATE "Subscription" SET enabled=false WHERE id=${g.target.subscriptionId}`, () => ''],
      ['Security disablement', g => `UPDATE "Security" SET enabled=false WHERE id=${g.target.securityId}`, () => ''],
    ];
    it.each(disablements.flatMap(row => [[row[0], true, row[1]], [row[0], false, row[1]]] as const))('%s versus claim (claim first: %s)', async (_name, claimFirst, sql) => {
      const graph = await pendingClaimGraph(`claim-${_name}-${claimFirst}`);
      const write = sql(graph);
      const claim = () => svc.worker.processTradingViewOrderIntentForC2(graph.intentId);
      if (claimFirst) {
        const gate = await hold([exposureGate(graph as never)]);
        const base = await waiters();
        const claimP = settle(claim());
        await untilWaiters(base + 1, 'claim parked after taking its identity share locks');
        const writeP = settle(db.query(write));
        await untilWaiters(base + 2, 'disablement queued behind the claim\'s FOR SHARE locks');
        await gate.commit();
        const [c, w] = await Promise.all([claimP, writeP]);
        expect(c).toEqual({ ok: true, value: { outcome: 'C2_DISPATCH_REFUSED' } }); expect(w.ok).toBe(true);
        expect(await claimState(graph.intentId)).toMatchObject({ status: 'blocked', worker_claims: 1, broker_orders: 0 });
      } else {
        const writer = await hold([write]);
        const claimP = settle(claim());
        await untilWaiters(1, 'claim queued behind the uncommitted disablement');
        await writer.commit();
        // The claim's SERIALIZABLE snapshot predates the disablement: a genuine 40001 is retried with a fresh snapshot.
        const c = await claimP;
        expect(c).toEqual({ ok: true, value: { outcome: 'C2_DISPATCH_REFUSED' } });
        expect(await claimState(graph.intentId)).toMatchObject({ status: 'blocked', blockReason: expect.stringMatching(/TRADINGVIEW_C2_(CLAIM_AUTHORITY|PRECLAIM_READINESS)_REFUSED/), worker_claims: 0, broker_orders: 0 });
      }
      await restoreAccount();
      await db.query(`UPDATE "TradingAccountSubscription" SET enabled=true,"entriesEnabled"=true WHERE id=$1`, [graph.target.assignmentId]);
      await db.query(`UPDATE "Subscription" SET enabled=true WHERE id=$1`, [graph.target.subscriptionId]);
      await db.query(`UPDATE "Security" SET enabled=true WHERE id=$1`, [graph.target.securityId]);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    it.each([['claim first', true], ['revocation first', false]])('TradingView authorization revocation during a lock wait: %s', async (_o, claimFirst) => {
      const graph = await pendingClaimGraph(`claim-revoke-${claimFirst}`);
      const claim = () => svc.worker.processTradingViewOrderIntentForC2(graph.intentId);
      const revoke = () => svc.authority.revokeExternalSignalEntryExecutionAuthorization(paperId, graph.target.assignmentId, graph.target.authorizationId, 'lock-order revocation', ownerId);
      if (claimFirst) {
        const { a, b } = await interleave({ gate: [exposureGate(graph as never)], first: claim, second: revoke, secondWaits: true });
        expect(a).toEqual({ ok: true, value: { outcome: 'C2_DISPATCH_REFUSED' } }); expect(b.ok).toBe(true);
        expect(await claimState(graph.intentId)).toMatchObject({ worker_claims: 1, broker_orders: 0 });
      } else {
        const { a, b } = await interleave({ gate: [`SELECT id FROM "ExternalSignalEntryExecutionAuthorization" WHERE id=${graph.target.authorizationId} FOR UPDATE`], first: revoke, second: claim, secondWaits: false });
        expect(a.ok).toBe(true);
        expect(b).toMatchObject({ ok: true });
        // Revocation committed first: the stale pre-lock validation cannot resurrect the authority.
        expect(await claimState(graph.intentId)).toMatchObject({ status: 'blocked', worker_claims: 0, broker_orders: 0 });
      }
      expect(await tvAuthorizationCount(graph.target.assignmentId, 'REVOKED')).toBe(1);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);
  });

  // ---- 3. refuseCandidate through the real coordinator ------------------------------------------------------
  describe('refuseCandidate (processProspectiveTradingViewEntries)', () => {
    const refuseAll = () => svc.admission.processProspectiveTradingViewEntries({ db: svc.prisma, limit: 50, maxAgeMs: 1 });
    async function insertExit(cycleId: number, cycleRef: string) {
      await db.query('BEGIN');
      const signalId = (await db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","createdAt") SELECT "signalSourceId","strategySignalBindingId","strategyId","securityId",2,$2,$3,$4,"strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",'EXIT_LONG',symbol,'15m',now(),$5,now() FROM "Signal" WHERE "externalSignalTradeCycleId"=$1 AND event='ENTRY_LONG' LIMIT 1 RETURNING id`, [cycleId, `exit:${randomUUID()}`, cycleRef, randomUUID(), 'b'.repeat(64)])).rows[0].id as number;
      await db.query(`INSERT INTO "ExternalSignalCorrelationWork" ("signalId",status,"attemptCount","nextAttemptAt","createdAt","updatedAt") VALUES ($1,'PENDING',0,now(),now(),now())`, [signalId]);
      await db.query('COMMIT');
      return signalId;
    }

    it.each([['EXIT correlation first', true], ['refusal first', false]])('versus EXIT correlation, %s', async (_o, exitFirst) => {
      await cleanProspectives();
      const target = await fx.createTarget();
      const graph = await fx.prospective(`refuse-exit-${exitFirst}`, target);
      const exitId = await insertExit(graph.cycleId, graph.cycleRef);
      // EXIT correlation is SERIALIZABLE: a refusal that commits first is a genuine 40001 for its older snapshot,
      // recorded as RETRY_WAIT. The safe retry (fresh snapshot) must then complete the accepted EXIT.
      const exit = async () => {
        const total = { completed: 0, failed: 0, retries: 0 };
        for (let attempt = 0; attempt < 6 && total.completed === 0; attempt += 1) {
          if (attempt > 0) await sleep(1200);
          const r = await svc.correlation.processExternalSignalCorrelationWork({ db: svc.prisma, limit: 1 });
          total.completed += r.completed; total.failed += r.failed; total.retries += r.retrying;
        }
        return total;
      };
      const { a, b } = await interleave({ gate: [lockCycle(graph.cycleId)], first: exitFirst ? exit : refuseAll, second: exitFirst ? refuseAll : exit, secondWaits: true });
      const [exitResult, refuseResult] = (exitFirst ? [a, b] : [b, a]) as [Settled<{ completed: number; failed: number }>, Settled<{ refused: number }>];
      expect(exitResult, message((exitResult as { error?: unknown }).error)).toMatchObject({ ok: true, value: { completed: 1, failed: 0 } });
      expect(refuseResult, message((refuseResult as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect((await db.query(`SELECT status::text FROM "ExternalSignalCorrelationWork" WHERE "signalId"=$1`, [exitId])).rows[0].status).toBe('COMPLETED');
      const status = (await db.query(`SELECT status::text FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [graph.accountCycleId])).rows[0].status as string;
      const refusedEvents = (await db.query(`SELECT count(*)::int n FROM "SystemEvent" WHERE type='TRADINGVIEW_ENTRY_ADMISSION_REFUSED' AND "entityId"=$1`, [String(graph.accountCycleId)])).rows[0].n as number;
      // Exactly one party moved the prospective account cycle; no intent or claim was ever created.
      if (exitFirst) { expect(status).not.toBe('ENTRY_EXECUTION_PROSPECTIVE'); }
      expect(refusedEvents).toBe(exitFirst ? (status === 'BLOCKED' ? 1 : 0) : 1);
      expect((await db.query(`SELECT count(*)::int n FROM "OrderIntent" WHERE "externalSignalAccountCycleId"=$1`, [graph.accountCycleId])).rows[0].n).toBe(0);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);

    it.each([['entry recovery first', true], ['refusal first', false]])('versus entry recovery of a sibling account cycle, %s', async (_o, recoveryFirst) => {
      await cleanProspectives();
      // Sibling account cycles of one source cycle: one awaiting recovery, one prospective. A route set is immutable
      // evidence of its run, so both are routed by the same run (the sibling on its own paper account).
      const holder = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ($1,'SYSTEM_OWNER',true,now(),now()) RETURNING id`, [`sibling-${randomUUID()}@test`])).rows[0].id as number;
      const paper2 = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,$2,'PAPER','ACTIVE',true,false,false,now(),now()) RETURNING id`, [holder, `sibling ${randomUUID()}`])).rows[0].id as number;
      const recoverable = await fx.admit(`refuse-recovery-${recoveryFirst}`, { tradingAccountId: paper2 });
      await db.query(`UPDATE "OrderIntent" SET status='blocked',"blockReason"='lock-order sibling' WHERE id=$1`, [recoverable.intentId]);
      const sibling = recoverable.siblingAccountCycleId!;
      await db.query(`UPDATE "ExternalSignalTradeCycleAccount" SET status='ENTRY_EXECUTION_PROSPECTIVE',"entryRolloutGenerationId"=$2 WHERE id=$1`, [sibling, fx.executeGenerationId]);
      const recover = () => svc.entryRecovery.reconcileReleasedTradingViewAdmissionCyclesForAccount(paperId, { db: svc.prisma, limit: 50 });
      const { a, b } = await interleave({ gate: [lockCycle(recoverable.cycleId)], first: recoveryFirst ? recover : refuseAll, second: recoveryFirst ? refuseAll : recover, secondWaits: true });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect((await db.query(`SELECT status::text FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [sibling])).rows[0].status).toBe('BLOCKED');
      expect((await db.query(`SELECT count(*)::int n FROM "OrderIntent" WHERE "externalSignalAccountCycleId"=$1`, [sibling])).rows[0].n).toBe(0);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);
  });

  // ---- 4. Marked TradingView admission against Market Intelligence ------------------------------------------
  describe('TradingView admission (processProspectiveTradingViewEntries) versus Market Intelligence', () => {
    const admit = () => svc.admission.processProspectiveTradingViewEntries({ db: svc.prisma, limit: 50 });
    async function admissionOutcome(accountCycleId: number) {
      const row = (await db.query(`SELECT ac.status::text, ac."entryOrderIntentId",
        (SELECT count(*)::int FROM "ExternalSignalEntryExecutionObligation" o WHERE o."accountCycleId"=ac.id) tv_obligations,
        (SELECT count(*)::int FROM "OrderIntentMarketPolicyEnforcementObligation" m WHERE m."orderIntentId"=ac."entryOrderIntentId") mi_obligations,
        (SELECT count(*)::int FROM "BrokerOrder" b WHERE b."orderIntentId"=ac."entryOrderIntentId") broker_orders
        FROM "ExternalSignalTradeCycleAccount" ac WHERE ac.id=$1`, [accountCycleId])).rows[0];
      return row as { status: string; entryOrderIntentId: number | null; tv_obligations: number; mi_obligations: number; broker_orders: number };
    }
    const admitted = { status: 'ENTRY_INTENT_CREATED', tv_obligations: 1, mi_obligations: 1, broker_orders: 0 };
    const refused = { status: 'BLOCKED', entryOrderIntentId: null, tv_obligations: 0, mi_obligations: 0, broker_orders: 0 };

    it.each([['admission first', true], ['MI grant first', false]])('versus MI grant, %s', async (_o, admissionFirst) => {
      await cleanProspectives();
      const { target, generation } = await miTarget({ grant: false });
      const graph = await fx.prospective(`adm-grant-${admissionFirst}`, target);
      const grant = () => miGrant(target.assignmentId, generation);
      const { a, b } = await interleave({
        gate: [admissionFirst ? `SELECT id FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id=1 FOR UPDATE` : lockSecurity(target.securityId)],
        first: admissionFirst ? admit : grant, second: admissionFirst ? grant : admit, secondWaits: true,
      });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      // Admission before the grant sees an unenforced assignment and is refused; after it, the entry is admitted with its frozen obligation.
      expect(await admissionOutcome(graph.accountCycleId)).toMatchObject(admissionFirst ? refused : admitted);
      expect(await miStatuses(target.assignmentId)).toEqual(['AUTHORIZED']);
      expect(await newDeadlocks()).toBe(0);
    }, 90_000);

    it.each([['admission first', true], ['MI revoke first', false]])('versus MI revoke, %s', async (_o, admissionFirst) => {
      await cleanProspectives();
      const { target, authorization } = await miTarget();
      const graph = await fx.prospective(`adm-revoke-${admissionFirst}`, target);
      const revoke = () => miRevoke(target.assignmentId, authorization!.id);
      const { a, b } = await interleave({
        gate: [admissionFirst ? exposureKey(paperId, target.securityId) : lockMiAuthorization(authorization!.id)],
        first: admissionFirst ? admit : revoke, second: admissionFirst ? revoke : admit, secondWaits: true,
      });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      // A revocation that commits first cannot be bypassed by the admission's earlier validation.
      expect(await admissionOutcome(graph.accountCycleId)).toMatchObject(admissionFirst ? admitted : refused);
      expect(await miStatuses(target.assignmentId)).toEqual(['REVOKED']);
      expect(await newDeadlocks()).toBe(0);
    }, 90_000);

    it.each([['admission first', true], ['MI lapse resolution first', false]])('versus MI lapse resolution, %s', async (_o, admissionFirst) => {
      await cleanProspectives();
      const { target, authorization } = await miTarget({ lapse: true });
      const graph = await fx.prospective(`adm-lapse-${admissionFirst}`, target);
      const resolve = () => miLapseResolve(target.assignmentId, authorization!.id);
      const { a, b } = await interleave({
        gate: [admissionFirst ? exposureKey(paperId, target.securityId) : lockMiAuthorization(authorization!.id)],
        first: admissionFirst ? admit : resolve, second: admissionFirst ? resolve : admit, secondWaits: true,
      });
      expect(a, message((a as { error?: unknown }).error)).toMatchObject({ ok: true }); expect(b, message((b as { error?: unknown }).error)).toMatchObject({ ok: true });
      expect(await admissionOutcome(graph.accountCycleId)).toMatchObject(refused);
      expect((await db.query(`SELECT count(*)::int n FROM "AssignmentMarketPolicyEnforcementLapseResolution" WHERE "authorizationId"=$1`, [authorization!.id])).rows[0].n).toBe(1);
      expect(await newDeadlocks()).toBe(0);
    }, 90_000);

    it('admits one frozen obligation per symbol and stays inert with enforcement active', async () => {
      await cleanProspectives();
      const { target } = await miTarget();
      const graph = await fx.prospective('adm-baseline', target);
      expect(await admit()).toMatchObject({ admitted: 1 });
      expect(await admissionOutcome(graph.accountCycleId)).toMatchObject(admitted);
      expect(await newDeadlocks()).toBe(0);
    }, 60_000);
  });

  // ---- 5. Rollout activation change during a lock wait (last: deactivation closes dispatch for good) -------
  it('an ENTRY rollout deactivation during a claim lock wait: claim first, then no later claim', async () => {
    const graph = await pendingClaimGraph('claim-deactivate');
    const next = await pendingClaimGraph('claim-after-deactivate');
    const claim = () => svc.worker.processTradingViewOrderIntentForC2(graph.intentId);
    const deactivate = () => svc.authority.changeExternalSignalExecutionRollout(fx.executeGenerationId, 'DEACTIVATE', 'lock-order deactivation', ownerId);
    const { a, b } = await interleave({ gate: [exposureGate(graph as never)], first: claim, second: deactivate, secondWaits: true });
    expect(a).toEqual({ ok: true, value: { outcome: 'C2_DISPATCH_REFUSED' } }); expect(b.ok).toBe(true);
    expect((await claimState(graph.intentId)).worker_claims).toBe(1);
    // Dispatch authority is closed for good: a later claim is never made, and the intent stays untouched.
    expect(await svc.worker.processTradingViewOrderIntentForC2(next.intentId)).toEqual({ outcome: 'NOT_CLAIMED' });
    expect(await claimState(next.intentId)).toMatchObject({ status: 'pending', worker_claims: 0, broker_orders: 0 });
    expect(await newDeadlocks()).toBe(0);
  }, 60_000);

  it('no scenario made a broker request', () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

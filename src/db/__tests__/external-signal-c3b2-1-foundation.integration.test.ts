import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgresDatabase, type DisposablePostgresDatabase } from './disposable-postgres.js';
import { createTradingViewGraphFixture } from './tradingview-graph.fixture.js';
import { assessDatabaseSecurity, CRITICAL_TRIGGERS, evaluateTriggerOrder, TRIGGER_ORDER_INVARIANTS } from '../../services/database-security-readiness.service.js';

// Phase 4A.2C3B.2-1: the database safety foundation (dispatch fence, receipt clock, account-scoped broker-evidence identity, quarantine).
// Everything here is INERT infrastructure: no broker call is possible, the broker transport is replaced by a spy that fails, and no
// production code writes a TradingView consumption. Controls that disable a trigger or the replication role do so deliberately, as the
// table owner, inside the disposable database, and say so.

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const fenceOf = async (c: Client, intentId: number) => Number((await c.query(`SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [intentId])).rows[0]?.version ?? NaN);

(enabled ? describe : describe.skip)('TradingView C3B.2-1 database foundation (PostgreSQL)', () => {
  const fetchSpy = vi.fn(async () => { throw new Error('C3B.2-1 tests forbid broker network access'); });
  let disposable: DisposablePostgresDatabase;
  let db: Client;
  let fx: Awaited<ReturnType<typeof createTradingViewGraphFixture>>;
  let paperId: number, ownerId: number, liveId: number;
  let sequence = 0;
  const open: Client[] = [];
  const connect = async () => { const client = new Client({ connectionString: disposable.url }); await client.connect(); open.push(client); return client; };
  const rejects = async (promise: Promise<unknown>, pattern: RegExp) => { await expect(promise).rejects.toThrow(pattern); };

  beforeAll(async () => {
    vi.stubGlobal('fetch', fetchSpy);
    disposable = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'c3b21');
    await disposable.migrate(); // genuine `prisma migrate deploy`
    process.env.DATABASE_URL = disposable.url;
    db = await connect();
    fx = await createTradingViewGraphFixture(db);
    ({ paperId, ownerId } = fx);
    liveId = (await db.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,'C3B.2-1 live','LIVE','PAUSED',false,true,false,now(),now()) RETURNING id`, [ownerId])).rows[0].id as number;
  }, 240_000);

  afterAll(async () => {
    for (const client of open) await client.query('ROLLBACK').catch(() => undefined);
    await (await import('../../services/trading-account-workflow-lock.service.js')).closeTradingAccountWorkflowLockPool().catch(() => undefined);
    await (await import('../prisma.js')).prisma.$disconnect();
    for (const client of open) await client.end().catch(() => undefined);
    await disposable?.drop();
    vi.unstubAllGlobals();
  });

  /** An unmarked intent (sell side, so Market Intelligence BUY obligations never apply) on any account. */
  async function unmarkedIntent(accountId: number, label: string) {
    sequence += 1;
    return (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('manual',$3,'sell','market','day','received',$2,'{}',$1,now(),now()) RETURNING id`, [accountId, `${label}-${randomUUID()}`, `UM${sequence}`])).rows[0].id as number;
  }
  const brokerOrder = (client: Client, o: { intentId: number; accountId: number | null; clientOrderId: string; brokerOrderId: string; securityId: number }) =>
    client.query(`INSERT INTO "BrokerOrder" ("orderIntentId","tradingAccountId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","updatedAt","securityId") VALUES ($1,$2,'alpaca',$3,$4,'TVX','buy','accepted','{}',now(),$5) RETURNING id`, [o.intentId, o.accountId, o.brokerOrderId, o.clientOrderId, o.securityId]);
  const brokerActivity = (client: Client, o: { accountId: number | null; intentId?: number | null; orderId?: string | null; recordId?: number | null }) =>
    client.query(`INSERT INTO "BrokerActivity" ("tradingAccountId","orderIntentId","orderId","brokerOrderRecordId",broker,mode,"activityId","activityType","rawBrokerJson","updatedAt") VALUES ($1,$2,$3,$4,'alpaca','paper',$5,'FILL','{}',now()) RETURNING id`, [o.accountId, o.intentId ?? null, o.orderId ?? null, o.recordId ?? null, `act-${randomUUID()}`]);
  const markedFor = async (c: Client, intentId: number | null, clientOrderId: string | null, brokerOrderId: string | null, accountId: number | null, recordId: number | null = null) =>
    (await c.query(`SELECT m FROM external_signal_broker_evidence_marked_intents($1,$2,$3,$4,$5) m`, [intentId, clientOrderId, brokerOrderId, accountId, recordId])).rows.map(row => row.m as number);
  /** Runs a body with one trigger switched off by the table owner (an explicit control), always re-enabling it. */
  async function withTriggerOff<T>(table: string, trigger: string, body: () => Promise<T>) {
    await db.query(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
    try { return await body(); } finally { await db.query(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`); }
  }
  const quarantineOff = <T>(table: 'BrokerOrder' | 'BrokerActivity', body: () => Promise<T>) => withTriggerOff(table, `${table}_external_signal_quarantine`, body);

  // -------------------------------------------------------------------------------------------------------------
  describe('dispatch fence creation and backfill', () => {
    it('creates one version-1-based fence for every marked intent and none for unmarked intents', async () => {
      const unmarked = await unmarkedIntent(paperId, 'fence-unmarked');
      const marked = await fx.admit('fence-marked');
      expect(await fenceOf(db, marked.intentId)).toBeGreaterThanOrEqual(1);
      expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [unmarked])).rows[0].n).toBe(0);
      expect((await db.query(`SELECT
        (SELECT count(*)::int FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId"=i.id)) AS missing,
        (SELECT count(*)::int FROM "ExternalSignalDispatchFence" f WHERE NOT EXISTS (SELECT 1 FROM "OrderIntent" i WHERE i.id=f."orderIntentId" AND i."externalSignalAccountCycleId" IS NOT NULL)) AS unexpected`)).rows[0]).toEqual({ missing: 0, unexpected: 0 });
    });

    it('creates the fence inside the intent insert at exactly version 1; the very next fenced write is the first bump', async () => {
      const target = await fx.createTarget();
      const graph = await fx.prospective('fence-v1', target);
      await db.query('BEGIN');
      try {
        const intentId = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","tradingAccountSubscriptionId","subscriptionId","externalSignalAccountCycleId","createdAt","updatedAt") VALUES ('tradingview',$5,'buy','market','day','received',$4,'{}',$1,$2,$3,$6,now(),now()) RETURNING id`,
          [paperId, target.assignmentId, target.subscriptionId, `fence-v1-${randomUUID()}`, target.symbol, graph.accountCycleId])).rows[0].id as number;
        expect(await fenceOf(db, intentId)).toBe(1);
        await db.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,'c3b21-v1','ENTRY_PENDING',now(),now())`, [paperId, target.securityId, intentId]);
        expect(await fenceOf(db, intentId)).toBeGreaterThan(1);
      } finally { await db.query('ROLLBACK'); }
    });
  });

  describe('the fence cannot be forged, deleted, truncated, reset or arbitrarily incremented', () => {
    it.each([
      ['a direct INSERT for an existing marked intent', (id: number) => `INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES (${id}, 1)`, /created only by the marked-intent creation trigger|duplicate key/],
      ['a direct UPDATE by +1', (id: number) => `UPDATE "ExternalSignalDispatchFence" SET version = version + 1 WHERE "orderIntentId" = ${id}`, /only trigger-issued \+1 increments/],
      ['a direct reset to 1', (id: number) => `UPDATE "ExternalSignalDispatchFence" SET version = 1 WHERE "orderIntentId" = ${id}`, /only trigger-issued \+1 increments/],
      ['a direct jump of +1000', (id: number) => `UPDATE "ExternalSignalDispatchFence" SET version = version + 1000 WHERE "orderIntentId" = ${id}`, /only trigger-issued \+1 increments/],
      ['a DELETE', (id: number) => `DELETE FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = ${id}`, /never deleted or truncated/],
      ['a TRUNCATE', () => `TRUNCATE "ExternalSignalDispatchFence"`, /never deleted or truncated/],
      ['a cascading TRUNCATE from the parent table', () => `TRUNCATE "OrderIntent" CASCADE`, /never deleted or truncated/],
    ])('refuses %s, even to the table owner', async (_label, sql, pattern) => {
      const marked = await fx.admit('fence-forge');
      const before = await fenceOf(db, marked.intentId);
      await rejects(db.query(sql(marked.intentId)), pattern);
      expect(await fenceOf(db, marked.intentId)).toBe(before);
    });

    it('refuses forged inserts: an unmarked intent, a wrong version, a missing intent, and a direct statement for a new marked intent', async () => {
      const unmarked = await unmarkedIntent(paperId, 'fence-forge-unmarked');
      await rejects(db.query(`INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 1)`, [unmarked]), /created only by the marked-intent creation trigger/);
      await rejects(db.query(`INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 999)`, [unmarked]), /created only by the marked-intent creation trigger/);
      await rejects(db.query(`INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES (987654321, 1)`), /created only by the marked-intent creation trigger|foreign key/);
      expect((await db.query(`SELECT count(*)::int n FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1`, [unmarked])).rows[0].n).toBe(0);
    });

    it('refuses to be advanced by calling the bump helper directly, because it only increments from trigger context', async () => {
      const marked = await fx.admit('fence-helper');
      const before = await fenceOf(db, marked.intentId);
      await rejects(db.query(`SELECT external_signal_dispatch_fence_advance(ARRAY[$1::int])`, [marked.intentId]), /only trigger-issued \+1 increments/);
      expect(await fenceOf(db, marked.intentId)).toBe(before);
    });

    it('also refuses a DELETE of the marked intent (the foreign key restricts it) and an update of the fence key', async () => {
      const marked = await fx.admit('fence-parent');
      await rejects(db.query(`DELETE FROM "OrderIntent" WHERE id=$1`, [marked.intentId]), /foreign key|delete|violates/i);
      await rejects(db.query(`UPDATE "ExternalSignalDispatchFence" SET "orderIntentId" = "orderIntentId" + 100000 WHERE "orderIntentId"=$1`, [marked.intentId]), /only trigger-issued \+1 increments|foreign key/);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('fence bumps', () => {
    it('advances strictly on every relevant marked write and never on an unmarked write (no exact counts asserted)', async () => {
      const g = await fx.admit('bump-matrix');
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['OrderIntent status update', () => db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [g.intentId])],
        ['worker claim insert (claim events follow)', async () => { await fx.workerClaim(g); }],
        ['exposure claim update', () => db.query(`UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"="lastDiagnosedAt" WHERE id=$1`, [g.claimId])],
        ['claim event insert (a non-owner type)', () => db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'REPEATED_OBSERVATION','{}')`, [g.claimId])],
      ];
      let last = await fenceOf(db, g.intentId);
      for (const [label, step] of steps) {
        await step().catch(error => { throw new Error(`${label}: ${message(error)}`); });
        const now = await fenceOf(db, g.intentId);
        expect(now, label).toBeGreaterThan(last);
        last = now;
      }
    });

    it('locks the affected OrderIntent before broker-evidence fence work and does not deadlock with claim-first diagnostics', async () => {
      const g = await fx.admit('broker-lock-order');
      const intentFirst = await connect();
      const brokerWriter = await connect();
      await quarantineOff('BrokerOrder', () => quarantineOff('BrokerActivity', async () => {
        await intentFirst.query('BEGIN');
        await intentFirst.query(`SELECT 1 FROM "OrderIntent" WHERE id=$1 FOR UPDATE`, [g.intentId]);
        const blockedOrder = brokerOrder(brokerWriter, { intentId: g.intentId, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: `lock-${randomUUID()}`, securityId: g.target.securityId });
        const state = await Promise.race([blockedOrder.then(() => 'completed'), new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 150))]);
        expect(state).toBe('waiting');
        await intentFirst.query('ROLLBACK');
        await blockedOrder;

        const claimFirst = await connect();
        await claimFirst.query('BEGIN');
        await claimFirst.query(`UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"=clock_timestamp() WHERE id=$1`, [g.claimId]);
        await claimFirst.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'REPEATED_OBSERVATION','{}')`, [g.claimId]);
        const activity = brokerActivity(brokerWriter, { accountId: paperId, intentId: g.intentId });
        const activityState = await Promise.race([activity.then(() => 'completed'), new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 150))]);
        expect(activityState).toBe('waiting');
        await claimFirst.query('COMMIT');
        await activity;
      }));
      const deadlocks = (await db.query(`SELECT deadlocks::int n FROM pg_stat_database WHERE datname=current_database()`)).rows[0].n as number;
      expect(deadlocks).toBe(0);
    });

    it('does not move any fence for unmarked lifecycle writes (zero fence-table writes inside the transaction)', async () => {
      const unmarked = await unmarkedIntent(paperId, 'inert');
      const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [`IN${sequence}`])).rows[0].id as number;
      const client = await connect();
      const fenceWrites = async () => (await client.query(`SELECT coalesce(n_tup_ins+n_tup_upd+n_tup_del,0)::int AS n FROM pg_stat_xact_user_tables WHERE relname='ExternalSignalDispatchFence'`)).rows[0]?.n ?? 0;
      await client.query('BEGIN');
      try {
        const base = await fenceWrites();
        await client.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [unmarked]);
        const claimId = (await client.query(`INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,'c3b21-inert','ENTRY_PENDING',now(),now()) RETURNING id`, [paperId, securityId, unmarked])).rows[0].id as number;
        await client.query(`UPDATE "EntryExposureClaim" SET status='ENTRY_SUBMITTING' WHERE id=$1`, [claimId]);
        await client.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") VALUES ($1,'REPEATED_OBSERVATION','{}')`, [claimId]);
        const orderId = (await brokerOrder(client, { intentId: unmarked, accountId: paperId, clientOrderId: `inert-${randomUUID()}`, brokerOrderId: `BO-${randomUUID()}`, securityId })).rows[0].id as number;
        await client.query(`UPDATE "BrokerOrder" SET status='filled' WHERE id=$1`, [orderId]);
        await brokerActivity(client, { accountId: paperId, intentId: unmarked, recordId: orderId });
        expect(await fenceWrites()).toBe(base);
      } finally { await client.query('ROLLBACK'); }
    });

    it.each([
      ['BrokerOrder INSERT by intent id', 'order-insert'],
      ['BrokerOrder status UPDATE', 'order-update'],
      ['BrokerOrder re-attribution away from the intent', 'order-reattribute'],
      ['BrokerOrder DELETE', 'order-delete'],
      ['BrokerActivity INSERT by intent id', 'activity-insert'],
      ['BrokerActivity INSERT by orderId through a same-account order', 'activity-by-order-id'],
      ['BrokerActivity INSERT by brokerOrderRecordId only', 'activity-by-record'],
      ['BrokerActivity later attribution to the intent', 'activity-late-attribution'],
    ])('bumps once the quarantine is relaxed (a control, owner-disabled): %s', async (_label, kind) => {
      const g = await fx.admit(`bump-evidence-${kind}`);
      const other = await unmarkedIntent(paperId, 'bump-other');
      await quarantineOff('BrokerOrder', () => quarantineOff('BrokerActivity', async () => {
        const base = await fenceOf(db, g.intentId);
        const order = (await brokerOrder(db, { intentId: g.intentId, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: `BO-${randomUUID()}`, securityId: g.target.securityId })).rows[0].id as number;
        let marker = await fenceOf(db, g.intentId);
        if (kind === 'order-insert') { expect(marker).toBeGreaterThan(base); return; }
        if (kind === 'order-update') { await db.query(`UPDATE "BrokerOrder" SET status='filled' WHERE id=$1`, [order]); }
        if (kind === 'order-reattribute') { await db.query(`UPDATE "BrokerOrder" SET "orderIntentId"=$2, "clientOrderId"=$3 WHERE id=$1`, [order, other, `moved-${randomUUID()}`]); }
        if (kind === 'order-delete') { await db.query(`DELETE FROM "BrokerOrder" WHERE id=$1`, [order]); }
        if (kind === 'activity-insert') { await brokerActivity(db, { accountId: paperId, intentId: g.intentId }); }
        if (kind === 'activity-by-order-id') { const row = (await db.query(`SELECT "brokerOrderId" FROM "BrokerOrder" WHERE id=$1`, [order])).rows[0]; await brokerActivity(db, { accountId: paperId, orderId: row.brokerOrderId }); }
        if (kind === 'activity-by-record') { await brokerActivity(db, { accountId: paperId, recordId: order }); }
        if (kind === 'activity-late-attribution') {
          const activity = (await brokerActivity(db, { accountId: paperId })).rows[0].id as number;
          marker = await fenceOf(db, g.intentId);
          await db.query(`UPDATE "BrokerActivity" SET "orderIntentId"=$2 WHERE id=$1`, [activity, g.intentId]);
        }
        expect(await fenceOf(db, g.intentId), kind).toBeGreaterThan(marker);
      }));
    });

    it('does not bump for a LIVE account whose order merely shares the clientOrderId, order id string or record id (account scope)', async () => {
      const g = await fx.admit('bump-account-scope');
      const liveIntent = await unmarkedIntent(liveId, 'live-scope');
      await quarantineOff('BrokerOrder', () => quarantineOff('BrokerActivity', async () => {
        const paperOrder = (await brokerOrder(db, { intentId: g.intentId, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-SHARED', securityId: g.target.securityId })).rows[0].id as number;
        const base = await fenceOf(db, g.intentId);
        const liveOrder = (await brokerOrder(db, { intentId: liveIntent, accountId: liveId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-SHARED', securityId: g.target.securityId })).rows[0].id as number;
        await db.query(`UPDATE "BrokerOrder" SET status='filled' WHERE id=$1`, [liveOrder]);
        await brokerActivity(db, { accountId: liveId, orderId: 'BO-SHARED' });
        await brokerActivity(db, { accountId: liveId, recordId: liveOrder });
        await db.query(`UPDATE "BrokerOrder" SET "clientOrderId"=$2 WHERE id=$1`, [liveOrder, `retarget-${randomUUID()}`]);
        expect(await fenceOf(db, g.intentId)).toBe(base);
        // The same actions on the PAPER account do bump.
        await brokerActivity(db, { accountId: paperId, orderId: 'BO-SHARED' });
        expect(await fenceOf(db, g.intentId)).toBeGreaterThan(base);
        expect(paperOrder).toBeGreaterThan(0);
      }));
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('account-scoped broker-evidence identity and quarantine', () => {
    it('resolves intent id, frozen clientOrderId, broker order id and record id within the account, and nothing across accounts', async () => {
      const g = await fx.admit('identity');
      const liveIntent = await unmarkedIntent(liveId, 'identity-live');
      await quarantineOff('BrokerOrder', async () => {
        const order = (await brokerOrder(db, { intentId: g.intentId, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-ID-1', securityId: g.target.securityId })).rows[0].id as number;
        expect(await markedFor(db, g.intentId, null, null, paperId)).toEqual([g.intentId]);
        expect(await markedFor(db, null, g.clientOrderId, null, paperId)).toEqual([g.intentId]);
        expect(await markedFor(db, null, null, 'BO-ID-1', paperId)).toEqual([g.intentId]);
        expect(await markedFor(db, null, null, null, paperId, order)).toEqual([g.intentId]);
        expect(await markedFor(db, null, null, null, paperId)).toEqual([]);
        // The same identifiers on another account, on no account, or unmarked never match.
        expect(await markedFor(db, g.intentId, null, null, liveId)).toEqual([]);
        expect(await markedFor(db, g.intentId, null, null, null)).toEqual([]);
        expect(await markedFor(db, null, g.clientOrderId, null, liveId)).toEqual([]);
        expect(await markedFor(db, null, null, 'BO-ID-1', liveId)).toEqual([]);
        expect(await markedFor(db, null, null, null, liveId, order)).toEqual([]);
        expect(await markedFor(db, liveIntent, null, null, liveId)).toEqual([]);
        expect(await markedFor(db, liveIntent, null, null, paperId)).toEqual([]);
        // The reverse key returns exactly the rows that the forward key maps to the intent.
        expect((await db.query(`SELECT kind, id FROM external_signal_marked_intent_broker_evidence($1)`, [g.intentId])).rows).toEqual([{ kind: 'BrokerOrder', id: order }]);
      });
    });

    it('keeps the quarantine on: marked evidence is refused by intent id, frozen clientOrderId and order-id association; unrelated LIVE evidence is accepted', async () => {
      const g = await fx.admit('quarantine');
      const otherPaper = await unmarkedIntent(paperId, 'quarantine-paper');
      const liveIntent = await unmarkedIntent(liveId, 'quarantine-live');
      const base = await fenceOf(db, g.intentId);
      const marked = /marked external signal broker evidence is quarantined/;
      await rejects(brokerOrder(db, { intentId: g.intentId, accountId: paperId, clientOrderId: `q-${randomUUID()}`, brokerOrderId: 'BO-Q-1', securityId: g.target.securityId }), marked);
      await rejects(brokerOrder(db, { intentId: otherPaper, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-Q-2', securityId: g.target.securityId }), marked);
      await rejects(brokerActivity(db, { accountId: paperId, intentId: g.intentId }), marked);
      // A row that names the marked intent but carries another or no account is contradictory, whatever else it says.
      await rejects(brokerActivity(db, { accountId: liveId, intentId: g.intentId }), /different or unknown trading account/);
      await rejects(brokerActivity(db, { accountId: null, intentId: g.intentId }), /different or unknown trading account/);
      await rejects(brokerOrder(db, { intentId: g.intentId, accountId: liveId, clientOrderId: `q-${randomUUID()}`, brokerOrderId: 'BO-Q-3', securityId: g.target.securityId }), /different or unknown trading account/);
      // A LIVE order sharing the marked clientOrderId, and LIVE activity sharing order-id strings, are not PAPER evidence.
      const liveOrder = (await brokerOrder(db, { intentId: liveIntent, accountId: liveId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-Q-LIVE', securityId: g.target.securityId })).rows[0].id as number;
      await brokerActivity(db, { accountId: liveId, orderId: 'BO-Q-LIVE' });
      await brokerActivity(db, { accountId: liveId, recordId: liveOrder });
      await db.query(`UPDATE "BrokerOrder" SET status='filled' WHERE id=$1`, [liveOrder]);
      expect(await fenceOf(db, g.intentId)).toBe(base);
    });

    it('refuses an unattributable (no trading account) row that any identifier ties to a marked intent, and accepts an unrelated one', async () => {
      const g = await fx.admit('unattributable');
      await quarantineOff('BrokerOrder', async () => {
        await brokerOrder(db, { intentId: g.intentId, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-UNATTR', securityId: g.target.securityId });
      });
      const unattributable = /unattributable broker evidence/;
      await rejects(brokerActivity(db, { accountId: null, orderId: 'BO-UNATTR' }), unattributable);
      const record = (await db.query(`SELECT id FROM "BrokerOrder" WHERE "brokerOrderId"='BO-UNATTR'`)).rows[0].id as number;
      // Linked only by record id: refused either as unattributable or as a link to another account's order; both are fail-closed.
      await rejects(brokerActivity(db, { accountId: null, recordId: record }), /unattributable broker evidence|belongs to a different trading account/);
      await brokerActivity(db, { accountId: null, orderId: `unrelated-${randomUUID()}` });
    });

    it('rejects a BrokerActivity that references a BrokerOrder of another trading account, with no bump and no side effect (Hermes LOW)', async () => {
      const g = await fx.admit('cross-account-link');
      const liveIntent = await unmarkedIntent(liveId, 'cross-live');
      const paperOrder = await quarantineOff('BrokerOrder', async () => (await brokerOrder(db, { intentId: g.intentId, accountId: paperId, clientOrderId: g.clientOrderId, brokerOrderId: 'BO-X-1', securityId: g.target.securityId })).rows[0].id as number);
      const liveOrder = (await brokerOrder(db, { intentId: liveIntent, accountId: liveId, clientOrderId: `x-${randomUUID()}`, brokerOrderId: 'BO-X-2', securityId: g.target.securityId })).rows[0].id as number;
      const base = await fenceOf(db, g.intentId);
      const crossAccount = /references a BrokerOrder that belongs to a different trading account/;
      // A LIVE activity pointing at the PAPER marked evidence, and a PAPER activity pointing at a LIVE order.
      await rejects(brokerActivity(db, { accountId: liveId, recordId: paperOrder }), crossAccount);
      await rejects(brokerActivity(db, { accountId: null, recordId: paperOrder }), crossAccount);
      await rejects(brokerActivity(db, { accountId: paperId, recordId: liveOrder }), crossAccount);
      await rejects(brokerActivity(db, { accountId: paperId, recordId: paperOrder }), /marked external signal broker evidence is quarantined/);
      // A later re-link is refused the same way.
      const activity = (await brokerActivity(db, { accountId: liveId })).rows[0].id as number;
      await rejects(db.query(`UPDATE "BrokerActivity" SET "brokerOrderRecordId"=$2 WHERE id=$1`, [activity, paperOrder]), crossAccount);
      expect(await fenceOf(db, g.intentId)).toBe(base);
      expect((await db.query(`SELECT status::text FROM "EntryExposureClaim" WHERE id=$1`, [g.claimId])).rows[0].status).toBe('ENTRY_PENDING');
      // Unmarked same-account links remain valid (legacy compatibility).
      await brokerActivity(db, { accountId: liveId, recordId: liveOrder });
    });

    it('keeps legacy unmarked PAPER and LIVE broker writes working, including an unscoped legacy activity linked to an account order', async () => {
      const liveIntent = await unmarkedIntent(liveId, 'legacy-live');
      const securityId = (await db.query(`SELECT id FROM "Security" LIMIT 1`)).rows[0].id as number;
      const paperIntent = await unmarkedIntent(paperId, 'legacy-paper');
      const live = (await brokerOrder(db, { intentId: liveIntent, accountId: liveId, clientOrderId: `lg-${randomUUID()}`, brokerOrderId: `LG-${randomUUID()}`, securityId })).rows[0].id as number;
      const paper = (await brokerOrder(db, { intentId: paperIntent, accountId: paperId, clientOrderId: `lg-${randomUUID()}`, brokerOrderId: `LG-${randomUUID()}`, securityId })).rows[0].id as number;
      await brokerActivity(db, { accountId: liveId, recordId: live, intentId: liveIntent });
      await brokerActivity(db, { accountId: paperId, recordId: paper, intentId: paperIntent });
      await brokerActivity(db, { accountId: null, recordId: paper });
      await db.query(`UPDATE "BrokerOrder" SET status='filled' WHERE id IN ($1,$2)`, [live, paper]);
      await db.query(`DELETE FROM "BrokerOrder" WHERE id=$1`, [live]).catch(() => undefined);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('database-owned Signal receipt clock', () => {
    it('stamps receivedAt from the inserting transaction start, with no Prisma default, and rejects a supplied value', async () => {
      const graph = await fx.admit('receipt-stamp');
      const row = (await db.query(`SELECT s."receivedAt", s."createdAt", now() AS db_now FROM "Signal" s WHERE s.id=$1`, [graph.signalId])).rows[0];
      expect(row.receivedAt).toBeInstanceOf(Date);
      expect(Math.abs(row.db_now.getTime() - row.receivedAt.getTime())).toBeLessThan(60_000);
      const column = (await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name='Signal' AND column_name='receivedAt'`)).rows[0];
      expect(column).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES', column_default: null });
      for (const supplied of ['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z', 'now()']) {
        await rejects(db.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash","receivedAt") SELECT "signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion",'dup-' || gen_random_uuid(),"externalTradeCycleRef",gen_random_uuid()::text,"strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash",${supplied === 'now()' ? 'now()' : `'${supplied}'::timestamptz`} FROM "Signal" WHERE id=$1`, [graph.signalId]), /database-owned and cannot be supplied/);
      }
    });

    it('is immutable: no change, no null-to-value and no value-to-null, as the owner', async () => {
      const graph = await fx.admit('receipt-immutable');
      await rejects(db.query(`UPDATE "Signal" SET "receivedAt" = "receivedAt" + interval '1 second' WHERE id=$1`, [graph.signalId]), /receivedAt is immutable|timestamps are immutable|immutable/);
      await rejects(db.query(`UPDATE "Signal" SET "receivedAt" = NULL WHERE id=$1`, [graph.signalId]), /receivedAt is immutable|immutable/);
      await rejects(db.query(`UPDATE "Signal" SET "receivedAt" = now() WHERE id=$1`, [graph.signalId]), /receivedAt is immutable|immutable/);
    });

    it('is the same stamp for every row of one ingestion transaction (transaction start, not statement time)', async () => {
      const client = await connect();
      const a = await fx.admit('receipt-tx');
      await client.query('BEGIN');
      try {
        const start = (await client.query(`SELECT transaction_timestamp() AS t`)).rows[0].t as Date;
        await client.query(`SELECT pg_sleep(0.3)`);
        const receipt = (await client.query(`INSERT INTO "Signal" ("signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion","externalEventId","externalTradeCycleRef","eventFingerprint","strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",event,symbol,timeframe,"signalTime","canonicalPayloadHash") SELECT "signalSourceId","strategySignalBindingId","strategyId","securityId","schemaVersion",'tx-' || gen_random_uuid(),"externalTradeCycleRef",gen_random_uuid()::text,"strategyRevision","strategySignalRevisionId","externalSignalTradeCycleId",'EXIT_LONG',symbol,timeframe,"signalTime","canonicalPayloadHash" FROM "Signal" WHERE id=$1 RETURNING "receivedAt"`, [a.signalId])).rows[0].receivedAt as Date;
        expect(receipt.getTime()).toBe(start.getTime());
      } finally { await client.query('ROLLBACK'); }
    });

    it('answers identically in every session TimeZone, and a 200-second-old or NULL receipt is never open, whatever the zone', async () => {
      const fresh = await fx.admit('receipt-zone-fresh');
      const old = await fx.admit('receipt-zone-old');
      const historical = await fx.admit('receipt-zone-null');
      // Controls: age a receipt and remove one, the way history looks. The immutability guard is the thing being bypassed, deliberately,
      // inside a transaction that restores the replication role.
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role='replica'`);
      await db.query(`UPDATE "Signal" SET "receivedAt" = clock_timestamp() - interval '200 seconds' WHERE id=$1`, [old.signalId]);
      await db.query(`UPDATE "Signal" SET "receivedAt" = NULL WHERE id=$1`, [historical.signalId]);
      await db.query('COMMIT');
      const answers = new Set<string>();
      for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Etc/GMT+12', 'Asia/Tokyo', 'PST8PDT']) {
        for (const setter of [`SET TIME ZONE '${zone}'`, `SELECT set_config('TimeZone','${zone}',false)`]) {
          await db.query(setter);
          const r = (await db.query(`SELECT external_signal_signal_receipt_open($1) AS fresh, external_signal_signal_receipt_open($2) AS old, external_signal_signal_receipt_open($3) AS hist,
            external_signal_signal_received_since($1, now() - interval '1 hour') AS since_old_epoch, external_signal_signal_received_since($1, now() + interval '1 hour') AS since_future_epoch,
            external_signal_signal_received_since($3, '1970-01-01'::timestamptz) AS hist_since_epoch,
            external_signal_signal_receipt_remaining($3) IS NULL AS hist_remaining_null`, [fresh.signalId, old.signalId, historical.signalId])).rows[0];
          answers.add(JSON.stringify(r));
        }
      }
      await db.query(`SET TIME ZONE 'UTC'`);
      expect([...answers]).toEqual([JSON.stringify({ fresh: true, old: false, hist: false, since_old_epoch: true, since_future_epoch: false, hist_since_epoch: false, hist_remaining_null: true })]);
    });

    it('never gives a historical NULL receipt a value: the column has no default and the migration backfilled nothing', async () => {
      const text = await readFile('prisma/migrations/20261103120000_tradingview_receipt_clock_dispatch_fence_foundation/migration.sql', 'utf8');
      expect(text).toMatch(/ADD COLUMN "receivedAt" TIMESTAMPTZ;/);
      expect(text).not.toMatch(/UPDATE "Signal"/);
      expect(text).not.toMatch(/"receivedAt"[^;\n]*DEFAULT/i);
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('candidate-side epoch stamps', () => {
    it('stamps the account-cycle and the marked-intent creation time with the database clock, whatever the application supplies', async () => {
      const g = await fx.admit('epoch-stamp');
      const supplied = new Date(Date.now() - 6 * 3_600_000);
      const row = (await db.query(`SELECT ac."createdAt" AS account_created, (i."createdAt" AT TIME ZONE 'UTC') AS intent_created, now() AS db_now FROM "ExternalSignalTradeCycleAccount" ac JOIN "OrderIntent" i ON i."externalSignalAccountCycleId"=ac.id WHERE ac.id=$1`, [g.accountCycleId])).rows[0];
      expect(Math.abs(row.account_created.getTime() - row.db_now.getTime())).toBeLessThan(120_000);
      expect(Math.abs(row.intent_created.getTime() - row.db_now.getTime())).toBeLessThan(120_000);
      // Direct SQL cannot backdate either: an explicit past value is overwritten at insert.
      const target = await fx.createTarget();
      const graph = await fx.prospective('epoch-stamp-backdate', target);
      const reread = (await db.query(`SELECT "createdAt" FROM "ExternalSignalTradeCycleAccount" WHERE id=$1`, [graph.accountCycleId])).rows[0].createdAt as Date;
      expect(reread.getTime()).toBeGreaterThan(supplied.getTime());
    });

    it('does not rewrite the createdAt of an unmarked intent supplied by the application (legacy values are untouched)', async () => {
      sequence += 1;
      const id = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('manual',$2,'sell','market','day','received',$3,'{}',$1,TIMESTAMP '2020-02-02 02:02:02',now()) RETURNING id`, [paperId, `UM${sequence}`, `legacy-created-${randomUUID()}`])).rows[0].id as number;
      expect((await db.query(`SELECT to_char("createdAt",'YYYY-MM-DD HH24:MI:SS') s FROM "OrderIntent" WHERE id=$1`, [id])).rows[0].s).toBe('2020-02-02 02:02:02');
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('security manifest, critical triggers and trigger order', () => {
    it('reads clean against the reviewed manifest and every critical trigger, including the order invariants', async () => {
      const report = await assessDatabaseSecurity(async (sql, params) => (await db.query(sql, params as never)).rows as never, { mode: 'DEVELOPMENT_OBSERVATION' });
      const relevant = report.findings.filter(finding => ['PROTECTED_FUNCTION_CHANGED', 'PROTECTED_FUNCTION_MISSING', 'FUNCTION_NOT_IN_MANIFEST', 'TRIGGER_DEFINITION_CHANGED', 'PROTECTED_TRIGGER_MISSING', 'TRIGGER_NOT_IN_MANIFEST', 'CRITICAL_TRIGGER_UNSAFE', 'CRITICAL_TRIGGER_ORDER_UNSAFE', 'FUNCTION_SEARCH_PATH_UNPINNED', 'FUNCTION_SECURITY_DEFINER'].includes(finding.code));
      expect(relevant, JSON.stringify(relevant)).toEqual([]);
    });

    it('lists every new C3B.2-1 trigger as critical and every one is enabled and bound to its function', async () => {
      const wanted = ['ExternalSignalDispatchFence_guard', 'ExternalSignalDispatchFence_truncate_guard', 'OrderIntent_dispatch_fence_create', 'OrderIntent_dispatch_fence_bump', 'OrderIntent_a_epoch_stamp',
        'EntryExposureClaim_dispatch_fence_bump', 'EntryExposureClaimEvent_dispatch_fence_bump', 'ExternalSignalBrokerWorkerClaim_dispatch_fence_bump', 'MarketPolicyBrokerDispatchDecision_dispatch_fence_bump',
        'MarketPolicyBrokerUnenforcedDispatch_dispatch_fence_bump', 'OrderIntentBrokerOpportunityEvent_dispatch_fence_bump', 'BrokerOrder_dispatch_fence_bump', 'BrokerActivity_dispatch_fence_bump',
        'Signal_received_at_guard', 'ExternalSignalTradeCycleAccount_a_epoch_stamp', 'BrokerDispatchConsumption_a_lock_prelude', 'ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump', 'ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify'];
      const listed = new Set(CRITICAL_TRIGGERS.map(([, trigger]) => trigger));
      for (const name of wanted) expect(listed.has(name), name).toBe(true);
      const installed = (await db.query(`SELECT t.tgname, t.tgenabled FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[])`, [wanted])).rows;
      expect(installed.map(row => row.tgname).sort()).toEqual([...wanted].sort());
      expect(installed.every(row => row.tgenabled === 'O')).toBe(true);
    });

    it('catches a trigger that sorts between a listed pair, a renamed trigger, and a disabled one (negative controls on a copy of the catalog)', async () => {
      const rows = (await db.query(`SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name, t.tgtype::int AS tgtype, t.tgenabled::text AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal`)).rows;
      expect(evaluateTriggerOrder(rows)).toEqual([]);
      const extra = { table_name: 'EntryExposureClaimEvent', trigger_name: 'EntryExposureClaimEvent_external_signal_c2_m_between', tgtype: 7, enabled: 'O' };
      expect(evaluateTriggerOrder([...rows, extra]).map(v => v.table)).toEqual(['EntryExposureClaimEvent']);
      const first = { table_name: 'MarketPolicyBrokerDispatchConsumption', trigger_name: 'BrokerDispatchConsumption_0_earlier', tgtype: 7, enabled: 'O' };
      expect(evaluateTriggerOrder([...rows, first]).map(v => v.table)).toEqual(['MarketPolicyBrokerDispatchConsumption']);
      expect(evaluateTriggerOrder(rows.map(r => r.trigger_name === 'EntryExposureClaimEvent_external_signal_c2_delivery_fence' ? { ...r, trigger_name: 'EntryExposureClaimEvent_external_signal_c2_zz_delivery_fence' } : r)).map(v => v.table)).toContain('EntryExposureClaimEvent');
      expect(TRIGGER_ORDER_INVARIANTS.length).toBeGreaterThanOrEqual(5);
    });

    it('detects drift of a protected function and of a trigger through the security readiness check, then restores it', async () => {
      const original = (await db.query(`SELECT pg_get_functiondef('external_signal_dispatch_fence_guard()'::regprocedure) AS def`)).rows[0].def as string;
      const tampered = original.replace('only trigger-issued +1 increments', 'anything goes');
      expect(tampered).not.toBe(original);
      const assess = async () => (await assessDatabaseSecurity(async (sql, params) => (await db.query(sql, params as never)).rows as never, { mode: 'DEVELOPMENT_OBSERVATION' })).findings.map(f => f.code);
      await db.query(tampered);
      try { expect(await assess()).toContain('PROTECTED_FUNCTION_CHANGED'); } finally { await db.query(original); }
      expect(await assess()).not.toContain('PROTECTED_FUNCTION_CHANGED');
      await db.query(`ALTER TABLE "ExternalSignalDispatchFence" DISABLE TRIGGER "ExternalSignalDispatchFence_guard"`);
      try { expect(await assess()).toEqual(expect.arrayContaining(['CRITICAL_TRIGGER_UNSAFE'])); } finally { await db.query(`ALTER TABLE "ExternalSignalDispatchFence" ENABLE TRIGGER "ExternalSignalDispatchFence_guard"`); }
    });

    it('pins the trusted search_path on every new and replaced function and none is SECURITY DEFINER', async () => {
      const rows = (await db.query(`SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f' AND (p.proname LIKE 'external_signal_%' OR p.proname LIKE 'validate_market_policy_%')`)).rows;
      expect(rows.length).toBeGreaterThan(40);
      for (const row of rows) { expect(row.prosecdef, row.proname).toBe(false); expect(row.proconfig, row.proname).toContain('search_path=pg_catalog, public, pg_temp'); }
    });
  });

  // -------------------------------------------------------------------------------------------------------------
  describe('inert infrastructure: nothing in production writes a TradingView consumption or reaches a broker', () => {
    it('keeps the test-only finalizer isolated from every runtime caller', async () => {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(process.execPath, ['-e', `
        const fs = require('node:fs'); const path = require('node:path');
        const hits = [];
        (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
          if (!/\\.ts$/.test(e.name) || /\\.test\\.ts$/.test(e.name) || /database-security-/.test(e.name)) continue;
          const text = fs.readFileSync(p, 'utf8');
          if (/INSERT INTO "ExternalSignalBrokerDispatchConsumption"|externalSignalBrokerDispatchConsumption\\.(create|createMany|upsert)|finalizeTradingViewDispatch/.test(text)) hits.push(p.replaceAll('\\\\','/'));
        } })('src');
        process.stdout.write(JSON.stringify(hits));`], { encoding: 'utf8' });
      expect((JSON.parse(out) as string[]).map(value => value.replaceAll('\\', '/'))).toEqual(['src/services/external-signal-broker-worker.service.ts']);
    });

    it('has no production permission or resolution writer', async () => {
      const { execFileSync } = await import('node:child_process');
      const out = execFileSync(process.execPath, ['-e', `
        const fs = require('node:fs'); const path = require('node:path'); const hits = [];
        (function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name);
          if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); continue; }
          if (!/\.ts$/.test(e.name) || /\.test\.ts$/.test(e.name) || /database-security-/.test(e.name)) continue;
          const text = fs.readFileSync(p, 'utf8');
          if (/ExternalSignalBrokerSendPermission|ExternalSignalBrokerSendResolution|externalSignalBrokerSend(Permission|Resolution)/.test(text)) hits.push(p.replaceAll('\\\\','/'));
        } })('src'); process.stdout.write(JSON.stringify(hits));`], { encoding: 'utf8' });
      expect(JSON.parse(out)).toEqual([]);
    });

    it('never supplies receivedAt from the ingestion service', async () => {
      const text = await readFile('src/services/external-signal-ingestion.service.ts', 'utf8');
      expect(text).not.toMatch(/receivedAt\s*:[^,}]*\bnew Date\b[^,}]*\}\s*\}\)/);
      const create = text.slice(text.indexOf('tx.signal.create'), text.indexOf('tx.signal.create') + 900);
      expect(create).not.toMatch(/\breceivedAt\b/);
    });

    it('performed no network call at any point in this suite', () => { expect(fetchSpy).not.toHaveBeenCalled(); });
  });
});

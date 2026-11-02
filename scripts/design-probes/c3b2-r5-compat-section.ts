// Sections D2/D5 of the revision-5 real-schema probes (carried from revision 4 and re-run against the revision-5 overlay): fence
// inertness for unmarked PAPER/LIVE records and bump semantics. The shared-key (D4) probes are replaced by c3b2-r5-scope-section.ts.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function run(ctx: any) {
  const { db, check, attempt, claimed, fenceOf, paperId } = ctx;
  const S = 'compat';
  const securityId = (await db.query('SELECT id FROM "Security" ORDER BY id LIMIT 1')).rows[0].id as number;
  let seq = 0;
  const uid = () => `r5c-${Date.now()}-${(seq += 1)}`;
  const unmarkedIntent = async () => (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('legacy','SEED','buy','market','day','received',$1,'{}',$2,now(),now()) RETURNING id, "clientOrderId"`, [uid(), paperId])).rows[0] as { id: number; clientOrderId: string };
  const brokerOrder = (intentId: number, clientOrderId: string, brokerOrderId: string) => attempt(db, `INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","createdAt","updatedAt","tradingAccountId","securityId") VALUES ($1,'alpaca',$2,$3,'SEED','buy','new','{}',now(),now(),$4,$5) RETURNING id`, [intentId, brokerOrderId, clientOrderId, paperId, securityId]);
  const totals = async () => (await db.query('SELECT count(*)::int n, coalesce(sum(version),0)::int s FROM "ExternalSignalDispatchFence"')).rows[0] as { n: number; s: number };

  // ---- D5: unmarked records never create, read-lock or bump a fence. Statistics are read inside the transaction.
  {
    const before = await totals();
    await db.query('BEGIN');
    const rawStat = async () => (await db.query(`SELECT coalesce(n_tup_ins,0)::int ins, coalesce(n_tup_upd,0)::int upd, coalesce(n_tup_del,0)::int del FROM pg_stat_xact_user_tables WHERE relname='ExternalSignalDispatchFence'`)).rows[0] ?? { ins: 0, upd: 0, del: 0 };
    const stat0 = await rawStat();
    const errors: string[] = [];
    const run = async (label: string, sql: string, params: unknown[] = []) => { const r = await attempt(db, `SAVEPOINT s`); void r; const o = await attempt(db, sql, params); if (!o.ok) { errors.push(`${label}: ${o.message}`); await db.query('ROLLBACK TO SAVEPOINT s'); } return o; };
    const intent = await unmarkedIntent();
    await run('claim insert', `INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now())`, [paperId, securityId, intent.id, uid()]);
    await run('claim update', `UPDATE "EntryExposureClaim" SET status='ENTRY_SUBMITTING' WHERE "orderIntentId"=$1`, [intent.id]);
    await run('claim event', `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'DISPATCH_OUTCOME_RECORDED','{}' FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [intent.id]);
    await run('intent updates', `UPDATE "OrderIntent" SET status='submitting' WHERE id=$1`, [intent.id]);
    await run('intent progress', `UPDATE "OrderIntent" SET status='submitted' WHERE id=$1`, [intent.id]);
    const bo = await run('broker order insert', `INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","createdAt","updatedAt","tradingAccountId","securityId") VALUES ($1,'alpaca',$2,$3,'SEED','buy','new','{}',now(),now(),$4,$5)`, [intent.id, uid(), intent.clientOrderId, paperId, securityId]);
    await run('broker order status sync', `UPDATE "BrokerOrder" SET status='filled',"updatedAt"=now() WHERE "orderIntentId"=$1`, [intent.id]);
    const orderId = (await db.query(`SELECT "brokerOrderId" FROM "BrokerOrder" WHERE "orderIntentId"=$1`, [intent.id])).rows[0]?.brokerOrderId ?? 'none';
    await run('activity insert (legacy fill import)', `INSERT INTO "BrokerActivity" (broker,mode,"activityId","activityType","activityCategory",symbol,side,qty,"cumQty","leavesQty",price,"netAmount","orderId","orderIntentId","transactionTime","rawBrokerJson","createdAt","updatedAt","tradingAccountId") VALUES ('alpaca','paper',$1,'FILL','FILL','SEED','buy',1,1,0,1,1,$2,NULL,now(),'{}',now(),now(),$3)`, [uid(), orderId, paperId]);
    await run('activity attribution updateMany', `UPDATE "BrokerActivity" SET "orderIntentId"=$1 WHERE "orderId"=$2 AND "orderIntentId" IS NULL`, [intent.id, orderId]);
    await run('activity delete', `DELETE FROM "BrokerActivity" WHERE "orderId"=$1`, [orderId]);
    await run('broker order delete', `DELETE FROM "BrokerOrder" WHERE "orderIntentId"=$1`, [intent.id]);
    const lone = await unmarkedIntent();
    const loneSecurity = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [`L${Date.now() % 1e9}`])).rows[0].id;
    await run('lone claim insert', `INSERT INTO "EntryExposureClaim" ("tradingAccountId","securityId","orderIntentId","ownerKey",status,"createdAt","updatedAt") VALUES ($1,$2,$3,$4,'ENTRY_PENDING',now(),now())`, [paperId, loneSecurity, lone.id, uid()]);
    await run('claim delete', `DELETE FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [lone.id]);
    const stat1 = await rawStat();
    const s = { ins: stat1.ins - stat0.ins, upd: stat1.upd - stat0.upd, del: stat1.del - stat0.del };
    void bo;
    await db.query('ROLLBACK');
    const after = await totals();
    check(S, 'D5 unmarked intent lifecycle, claim, broker order, legacy fill import, activity sync and attribution run without error and never touch the fence', errors.length === 0 && s.ins === 0 && s.upd === 0 && s.del === 0 && before.n === after.n && before.s === after.s, { errors, fenceTupleWritesInTransaction: s, before, after });
  }

  // ---- D2: bump semantics on a marked intent (the C2 quarantine is irrelevant to these three statements).
  {
    const g3 = await claimed();
    const m3 = (await db.query('SELECT "orderIntentId" FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1', [g3.obligationId])).rows[0].orderIntentId as number;
    const b0 = await fenceOf(db, m3);
    await db.query('BEGIN');
    await db.query(`UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`, [m3]);
    await db.query(`UPDATE "EntryExposureClaim" SET "lastDiagnosedAt"="lastDiagnosedAt" WHERE "orderIntentId"=$1`, [m3]);
    await db.query(`INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'DISPATCH_OUTCOME_RECORDED','{}' FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [m3]);
    await db.query('COMMIT');
    const b1 = await fenceOf(db, m3);
    check(S, 'D2 one logical lifecycle event spanning several fenced rows advances the version once per row change (strictly increasing, never skipped, not "one per event")', b1 - b0 >= 3, { before: b0, after: b1 });
  }
}

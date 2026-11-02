// Section S of the revision-5 real-schema probes: the ACCOUNT-SCOPED broker-evidence identity key, the quarantine built on it, the fence
// bumps it drives, and the complete guard's use of it. A PAPER marked TradingView intent and a LIVE account share a clientOrderId and
// broker order ids; nothing of the LIVE account may bump, block or be blocked by the PAPER intent.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { activitySql, brokerOrderSql } from './c3b2-r5-common.js';

export async function run(ctx: any) {
  const { db, url, mk, attempt, check, claimed, decided, miInsert, tvInsert, pairCount, fenceOf, paperId, liveId } = ctx;
  const S = 'scope';
  let seq = 0;
  const uid = () => `r5s-${Date.now()}-${(seq += 1)}`;
  const quarantine = async (state: 'DISABLE' | 'ENABLE') => { for (const t of ['BrokerOrder', 'BrokerActivity']) await db.query(`ALTER TABLE "${t}" ${state} TRIGGER "${t}_external_signal_quarantine"`); };
  const unmarkedIntent = async (accountId: number, clientOrderId?: string) => (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('legacy','SEED','buy','market','day','received',$1,'{}',$2,now(),now()) RETURNING id`, [clientOrderId ?? uid(), accountId])).rows[0].id as number;
  const securityOf = async (g: any) => g.securityId as number;
  const bo = (g: any, intentId: number, accountId: number, clientOrderId: string, brokerOrderId = uid()) => attempt(db, brokerOrderSql, [intentId, brokerOrderId, clientOrderId, g.symbol, accountId, g.securityId]);
  const act = (g: any, orderId: string | null, intentId: number | null, recordId: number | null, accountId: number | null, mode = 'paper') => attempt(db, activitySql, [uid(), orderId, intentId, recordId, accountId, mode, g.symbol]);
  const keyed = async (g: any, args: Array<number | string | null>) => (await db.query('SELECT count(*)::int n FROM external_signal_broker_evidence_marked_intents($1,$2,$3,$4,$5) m WHERE m=$6', [args[0], args[1], args[2], args[3], args[4] ?? null, g.intentId])).rows[0].n as number;
  const bumps = async (g: any, fn: () => Promise<any>) => { const v0 = await fenceOf(db, g.intentId); const r = await fn(); return { ok: r.ok !== false, bumps: (await fenceOf(db, g.intentId))! - v0!, error: r.message as string | undefined, result: r }; };
  void securityOf;

  // ---- S0: the key function, called directly. Same identifiers under PAPER match, under LIVE or NULL do not.
  {
    const g = await claimed();
    await quarantine('DISABLE');
    try {
      const paperOrder = await bo(g, g.intentId, paperId, g.clientOrderId, `bid-${uid()}`);
      const paperOrderId = (await db.query('SELECT "brokerOrderId", id FROM "BrokerOrder" WHERE id=$1', [paperOrder.rows![0].id])).rows[0];
      const rows = {
        directPaper: await keyed(g, [g.intentId, null, null, paperId]), directLive: await keyed(g, [g.intentId, null, null, liveId]), directNull: await keyed(g, [g.intentId, null, null, null]),
        clientIdPaper: await keyed(g, [null, g.clientOrderId, null, paperId]), clientIdLive: await keyed(g, [null, g.clientOrderId, null, liveId]),
        brokerOrderIdPaper: await keyed(g, [null, null, paperOrderId.brokerOrderId, paperId]), brokerOrderIdLive: await keyed(g, [null, null, paperOrderId.brokerOrderId, liveId]),
        recordPaper: await keyed(g, [null, null, null, paperId, paperOrderId.id]), recordLive: await keyed(g, [null, null, null, liveId, paperOrderId.id]),
      };
      check(S, 'S0 the key maps every identifier shape to the marked intent only under the SAME account; LIVE and NULL never match', rows.directPaper === 1 && rows.clientIdPaper === 1 && rows.brokerOrderIdPaper === 1 && rows.recordPaper === 1 && rows.directLive + rows.directNull + rows.clientIdLive + rows.brokerOrderIdLive + rows.recordLive === 0, rows);
    } finally { await quarantine('ENABLE'); }
  }

  // ---- S1: PAPER and LIVE share a clientOrderId. QUARANTINE ENABLED (the real C3B.2 state): the LIVE order is accepted, moves no fence.
  {
    const g = await claimed();
    const liveIntent = await unmarkedIntent(liveId);
    const m = await bumps(g, async () => bo(g, liveIntent, liveId, g.clientOrderId, `live-${uid()}`));
    const liveBrokerOrderId = (await db.query('SELECT id, "brokerOrderId" FROM "BrokerOrder" WHERE "tradingAccountId"=$1 AND "clientOrderId"=$2', [liveId, g.clientOrderId])).rows[0];
    const a1 = await bumps(g, async () => act(g, liveBrokerOrderId.brokerOrderId, null, null, liveId, 'live'));
    const a2 = await bumps(g, async () => act(g, null, null, liveBrokerOrderId.id, liveId, 'live'));
    const a3 = await bumps(g, async () => attempt(db, `UPDATE "BrokerOrder" SET status='filled',"updatedAt"=now() WHERE id=$1`, [liveBrokerOrderId.id]));
    check(S, 'S1 a LIVE BrokerOrder sharing the marked PAPER clientOrderId is accepted by the quarantine and never bumps the PAPER fence (insert, activity by order id, activity by record id, status sync)', [m, a1, a2, a3].every(x => x.ok && x.bumps === 0), { brokerOrder: [m.ok, m.bumps, m.error], activityByOrderId: [a1.ok, a1.bumps, a1.error], activityByRecord: [a2.ok, a2.bumps, a2.error], statusSync: [a3.ok, a3.bumps, a3.error] });
  }

  // ---- S1b: the complete consumption guard is not blocked by LIVE rows with the same identifiers, and IS blocked by the PAPER equivalent.
  {
    const gLive = await claimed(); const dLive = await decided(gLive);
    const liveIntent = await unmarkedIntent(liveId);
    await bo(gLive, liveIntent, liveId, gLive.clientOrderId, `live-${uid()}`);
    const liveRow = (await db.query('SELECT id, "brokerOrderId" FROM "BrokerOrder" WHERE "tradingAccountId"=$1 AND "clientOrderId"=$2', [liveId, gLive.clientOrderId])).rows[0];
    await act(gLive, liveRow.brokerOrderId, null, null, liveId, 'live'); await act(gLive, null, null, liveRow.id, liveId, 'live');
    const f = await mk(url);
    let outcome = 'unknown';
    try {
      await f.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const v = (await f.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [gLive.intentId])).rows[0].v;
      const miId = await miInsert(f, gLive, dLive.decisionId);
      outcome = await tvInsert(f, gLive, miId, v).then(() => 'INSERTED', (e: any) => String(e.message).slice(0, 100));
      if (outcome === 'INSERTED') await f.query('COMMIT');
    } finally { await f.query('ROLLBACK').catch(() => undefined); await f.end(); }
    check(S, 'S1b LIVE rows that share the PAPER clientOrderId / order ids do not block the complete guard: the PAPER pair commits', outcome === 'INSERTED' && (await pairCount(gLive)).tv === 1, { outcome });
  }

  // ---- S2: the quarantine still rejects every PAPER association shape (it is the C3B.2 barrier until C3C), with a 0-bump control.
  {
    const g = await claimed();
    const paperOther = await unmarkedIntent(paperId);
    const direct = await bumps(g, async () => bo(g, g.intentId, paperId, `${g.clientOrderId}-x`, uid()));
    const byClientId = await bumps(g, async () => bo(g, paperOther, paperId, g.clientOrderId, uid()));
    const activityDirect = await bumps(g, async () => act(g, null, g.intentId, null, paperId));
    check(S, 'S2 PAPER evidence by orderIntentId, by the frozen clientOrderId (under another intent), and activity by intent id are rejected by the account-scoped quarantine; the fence does not move', !direct.ok && !byClientId.ok && !activityDirect.ok && /quarantined/.test(`${direct.error} ${byClientId.error} ${activityDirect.error}`) && direct.bumps + byClientId.bumps + activityDirect.bumps === 0, { direct: direct.error, byClientId: byClientId.error, activityDirect: activityDirect.error });
  }

  // ---- S3: contradictory attribution: a row that NAMES the PAPER marked intent but carries LIVE or no account is rejected (not silently ignored).
  {
    const g = await claimed();
    const boLive = await bumps(g, async () => bo(g, g.intentId, liveId, `${g.clientOrderId}-live`, uid()));
    const actLive = await bumps(g, async () => act(g, null, g.intentId, null, liveId, 'live'));
    const actNull = await bumps(g, async () => act(g, null, g.intentId, null, null));
    check(S, 'S3 a row naming the marked intent but carrying a LIVE or unknown account is rejected as contradictory; the PAPER fence does not move', [boLive, actLive, actNull].every(x => !x.ok && x.bumps === 0) && /different or unknown trading account/.test(`${boLive.error} ${actLive.error} ${actNull.error}`), { boLive: boLive.error, actLive: actLive.error, actNull: actNull.error });
  }

  // ---- S4: fence bumps with the quarantine relaxed (the C3C state). PAPER shapes bump; LIVE shapes do not; later attribution updates both ways.
  await quarantine('DISABLE');
  try {
    const g = await claimed();
    const paperOther = await unmarkedIntent(paperId);
    const liveIntent = await unmarkedIntent(liveId);
    const results4: Record<string, any> = {};
    results4.paperDirect = await bumps(g, async () => bo(g, g.intentId, paperId, `${g.clientOrderId}-d`, `bid-${uid()}`));
    const direct = (await db.query(`SELECT id, "brokerOrderId" FROM "BrokerOrder" WHERE "orderIntentId"=$1 AND "tradingAccountId"=$2`, [g.intentId, paperId])).rows[0];
    results4.paperByClientId = await bumps(g, async () => bo(g, paperOther, paperId, g.clientOrderId, `bid-${uid()}`));
    results4.paperActivityByOrderId = await bumps(g, async () => act(g, direct.brokerOrderId, null, null, paperId));
    results4.paperActivityByRecordOnly = await bumps(g, async () => act(g, null, null, direct.id, paperId));
    results4.liveBrokerOrderSameClientId = await bumps(g, async () => bo(g, liveIntent, liveId, g.clientOrderId, `live-${uid()}`));
    const liveRow = (await db.query('SELECT id, "brokerOrderId" FROM "BrokerOrder" WHERE "tradingAccountId"=$1 AND "clientOrderId"=$2', [liveId, g.clientOrderId])).rows[0];
    results4.liveActivityByOrderId = await bumps(g, async () => act(g, liveRow.brokerOrderId, null, null, liveId, 'live'));
    results4.liveActivityByRecordOnly = await bumps(g, async () => act(g, null, null, liveRow.id, liveId, 'live'));
    // The SAME order-id string in a LIVE activity as a PAPER broker order: account scoping separates them.
    results4.liveActivitySameOrderIdAsPaper = await bumps(g, async () => act(g, direct.brokerOrderId, null, null, liveId, 'live'));
    // Later attribution: an unattributed PAPER activity gets the marked intent (bump); a LIVE one does not (rejected or no bump).
    const unattrPaper = await act(g, `unrelated-${uid()}`, null, null, paperId);
    const unattrLive = await act(g, `unrelated-${uid()}`, null, null, liveId, 'live');
    results4.attributePaperActivity = await bumps(g, async () => attempt(db, `UPDATE "BrokerActivity" SET "orderIntentId"=$1 WHERE id=$2`, [g.intentId, unattrPaper.rows![0].id]));
    results4.moveAttributionAway = await bumps(g, async () => attempt(db, `UPDATE "BrokerActivity" SET "orderIntentId"=NULL WHERE id=$1`, [unattrPaper.rows![0].id]));
    results4.attributeLiveActivity = await bumps(g, async () => attempt(db, `UPDATE "BrokerActivity" SET "orderIntentId"=$1 WHERE id=$2`, [g.intentId, unattrLive.rows![0].id]));
    // Later clientOrderId / account re-attribution of a BrokerOrder.
    results4.liveOrderRetargetedToPaperClientId = await bumps(g, async () => attempt(db, `UPDATE "BrokerOrder" SET "clientOrderId"=$2 WHERE id=$1`, [liveRow.id, g.clientOrderId]));
    const R = results4;
    check(S, 'S4 PAPER shapes bump the fence once per matching row change (BrokerOrder by intent, by clientOrderId, activity by order id, activity by record id only); LIVE shapes never bump', R.paperDirect.bumps >= 1 && R.paperByClientId.bumps >= 1 && R.paperActivityByOrderId.bumps >= 1 && R.paperActivityByRecordOnly.bumps >= 1 && R.liveBrokerOrderSameClientId.bumps === 0 && R.liveActivityByOrderId.bumps === 0 && R.liveActivityByRecordOnly.bumps === 0 && R.liveActivitySameOrderIdAsPaper.bumps === 0 && R.liveOrderRetargetedToPaperClientId.bumps === 0,
      Object.fromEntries(Object.entries(R).map(([k, v]: any) => [k, { ok: v.ok, bumps: v.bumps, error: v.error }])));
    check(S, 'S4b later attribution updates: attributing a PAPER activity to the marked intent bumps and moving it away bumps again (old values resolve); attributing a LIVE activity to the PAPER marked intent bumps nothing (the key does not match across accounts)', R.attributePaperActivity.bumps >= 1 && R.moveAttributionAway.bumps >= 1 && R.attributeLiveActivity.bumps === 0, { attribute: R.attributePaperActivity.bumps, moveAway: R.moveAttributionAway.bumps, attributeLive: { ok: R.attributeLiveActivity.ok, bumps: R.attributeLiveActivity.bumps }, liveOrderRetargetedBumps: R.liveOrderRetargetedToPaperClientId.bumps });
  } finally { await quarantine('ENABLE'); }

  // ---- S4c: with the quarantine ENABLED, attributing a LIVE activity (or an unattributed NULL-account one) to the marked PAPER intent is rejected.
  {
    const g = await claimed();
    const liveAct = await act(g, `unrelated-${uid()}`, null, null, liveId, 'live');
    const nullAct = await act(g, `unrelated-${uid()}`, null, null, null);
    const a = await bumps(g, async () => attempt(db, `UPDATE "BrokerActivity" SET "orderIntentId"=$1 WHERE id=$2`, [g.intentId, liveAct.rows![0].id]));
    const b = await bumps(g, async () => attempt(db, `UPDATE "BrokerActivity" SET "orderIntentId"=$1 WHERE id=$2`, [g.intentId, nullAct.rows![0].id]));
    check(S, 'S4c [quarantine enabled] later attribution of a LIVE or NULL-account activity to the marked PAPER intent is rejected as contradictory and bumps nothing', !a.ok && !b.ok && a.bumps === 0 && b.bumps === 0 && /different or unknown trading account/.test(`${a.error} ${b.error}`), { live: a.error, unknown: b.error });
  }

  // ---- S5: unattributable (NULL account) rows that any identifier ties to a marked intent are rejected; unrelated NULL-account rows are not.
  {
    const g = await claimed();
    await quarantine('DISABLE');
    const paperRow = await bo(g, g.intentId, paperId, `${g.clientOrderId}-p`, `bid-${uid()}`);
    await quarantine('ENABLE');
    const brokerOrderId = (await db.query('SELECT "brokerOrderId", id FROM "BrokerOrder" WHERE id=$1', [paperRow.rows![0].id])).rows[0];
    const nullByOrderId = await act(g, brokerOrderId.brokerOrderId, null, null, null);
    const nullByRecord = await act(g, null, null, brokerOrderId.id, null);
    const nullUnrelated = await act(g, `unrelated-${uid()}`, null, null, null);
    check(S, 'S5 a NULL-account activity tied to a marked intent by order id or record id is rejected (unattributable); an unrelated NULL-account activity is accepted', !nullByOrderId.ok && !nullByRecord.ok && /unattributable/.test(`${nullByOrderId.message} ${nullByRecord.message}`) && nullUnrelated.ok, { nullByOrderId: nullByOrderId.message, nullByRecord: nullByRecord.message, nullUnrelated: nullUnrelated.ok });
  }
}

// Section A of the revision-5 real-schema probes: the dispatch fence version protocol re-run against the revision-5 overlay and the
// COMPLETE replaced consumption guard (see c3b2-r5-real-schema-probes.ts). Differences from the revision-4 section: F now takes the
// full canonical lock sequence (section 6.5 rows 1 to 23) instead of two rows, the guard itself revalidates everything, and A6c is
// re-stated because the guard now refuses a pair next to broker evidence even when the bump trigger is missing.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { lockFence, plainFence } from './c3b2-r5-common.js';
export async function run(ctx: any) {
  const { db, url, mk, attempt, pidOf, untilBlocked, check, claimed, decided, miInsert, tvInsert, pairCount, fenceOf, admin, lockRows } = ctx;
  const S = 'fence';
  const RC = 'READ COMMITTED', SER = 'SERIALIZABLE';
  const fresh = async () => { const g = await claimed(); const d = await decided(g); return { g, decisionId: d.decisionId as number }; };
  const brokerOrderSql = `INSERT INTO "BrokerOrder" ("orderIntentId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","createdAt","updatedAt","tradingAccountId","securityId") SELECT $5,'alpaca',$1,$2,$3,'buy','new','{}',now(),now(),$4,s."securityId" FROM "OrderIntent" i JOIN "Subscription" s ON s.id=i."subscriptionId" WHERE i.id=$5`;
  const writeBrokerOrder = (c: any, g: any, paperId: number) => attempt(c, brokerOrderSql, [`bo-${g.intentId}-${Math.random().toString(36).slice(2, 8)}`, g.clientOrderId, g.symbol, paperId, g.intentId]);
  const paperId = ctx.paperId;
  const lookup = async (g: any) => (await db.query('SELECT "releasedAt" IS NOT NULL AS released FROM "EntryExposureClaim" WHERE "orderIntentId"=$1', [g.intentId])).rows[0].released as boolean;
  const finish = async (...cs: any[]) => { for (const c of cs) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); } };

  // ---- A0: the fence table cannot be tampered with, even by a superuser session, outside trigger context.
  {
    const { g } = await fresh();
    const direct = await attempt(db, 'UPDATE "ExternalSignalDispatchFence" SET version = version + 1 WHERE "orderIntentId"=$1', [g.intentId]);
    const del = await attempt(db, 'DELETE FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [g.intentId]);
    const trunc = await attempt(db, 'TRUNCATE "ExternalSignalDispatchFence"');
    check(S, 'A0 direct UPDATE, DELETE and TRUNCATE of the fence are rejected', !direct.ok && !del.ok && !trunc.ok, { direct: direct.message, del: del.message, trunc: trunc.message });
  }

  // ---- A1: the revision-3 contradiction, reproduced with the real tables and the real TradingView consumption guard.
  {
    const { g, decisionId } = await fresh();
    await db.query(`CREATE TRIGGER zz_rev3_mi_bump AFTER INSERT ON "MarketPolicyBrokerDispatchConsumption" FOR EACH ROW EXECUTE FUNCTION external_signal_dispatch_fence_bump('direct','orderIntentId')`);
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g);
      const v = await lockFence(f, g.intentId);
      const mi = await miInsert(f, g, decisionId);
      const vAfterMi = await plainFence(f, g.intentId);
      const tv = await tvInsert(f, g, mi, v).then(() => ({ ok: true }), (e: any) => ({ ok: false, message: String(e.message).slice(0, 120) }));
      check(S, 'A1 revision-3 protocol (MI consumption in the bump set) is self-defeating', vAfterMi === v + 1 && !(tv as any).ok && /stale or missing/.test((tv as any).message ?? ''), { fenceReadByF: v, fenceAfterMiInsert: vAfterMi, tvInsert: tv });
    } finally { await finish(f); await db.query('DROP TRIGGER zz_rev3_mi_bump ON "MarketPolicyBrokerDispatchConsumption"'); }
  }

  // ---- A2: the corrected protocol; successful pair, with the fence traced at every step.
  let pairGraph: any;
  {
    const { g, decisionId } = await fresh(); pairGraph = g;
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g);
      const v0 = await lockFence(f, g.intentId);
      const mi = await miInsert(f, g, decisionId);
      const vAfterMi = await plainFence(f, g.intentId);
      await tvInsert(f, g, mi, v0);
      const vAfterTv = await plainFence(f, g.intentId);
      await f.query('COMMIT');
      const stored = (await db.query('SELECT "fenceVersion"::int AS fv FROM "ExternalSignalBrokerDispatchConsumption" WHERE "orderIntentId"=$1', [g.intentId])).rows[0].fv;
      const committed = await fenceOf(db, g.intentId);
      const pair = await pairCount(g);
      check(S, 'A2 corrected protocol commits the pair; MI insert leaves the version unchanged, the TV insert advances it exactly once', vAfterMi === v0 && vAfterTv === v0 + 1 && committed === v0 + 1 && stored === v0 && pair.mi === 1 && pair.tv === 1, { v0, vAfterMi, vAfterTv, committed, storedFenceVersion: stored, pair });
    } catch (e: any) { check(S, 'A2 corrected protocol commits the pair', false, String(e.message)); } finally { await finish(f); }
  }

  // ---- A2b: one-shot authorization is intact: the second pair attempt fails on the existing unique constraints.
  {
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, pairGraph);
      const v = await lockFence(f, pairGraph.intentId);
      const second = await attempt(f, `INSERT INTO "MarketPolicyBrokerDispatchConsumption" ("decisionId","orderIntentId","clientOrderId","evidenceJson") SELECT "decisionId","orderIntentId","clientOrderId",'{}' FROM "MarketPolicyBrokerDispatchConsumption" WHERE "orderIntentId"=$1`, [pairGraph.intentId]);
      check(S, 'A2b a second consumption for the same intent is rejected by the existing constraints', !second.ok && /duplicate key|unique|immutable|consum/i.test(second.message ?? ''), { fenceRead: v, second });
    } finally { await finish(f); }
  }

  // ---- A3: a rolled-back pair leaves no row and the fence at its pre-pair value; the pair can then be redone.
  {
    const { g, decisionId } = await fresh();
    const before = await fenceOf(db, g.intentId);
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g);
      const v0 = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, v0);
      const inTx = await plainFence(f, g.intentId);
      await f.query('ROLLBACK');
      const after = await fenceOf(db, g.intentId); const pair = await pairCount(g);
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g);
      const v1 = await lockFence(f, g.intentId); const mi2 = await miInsert(f, g, decisionId); await tvInsert(f, g, mi2, v1); await f.query('COMMIT');
      check(S, 'A3 rolled-back pair restores the fence and leaves no consumption; a retry then succeeds', before === v0 && inTx === v0 + 1 && after === before && pair.mi === 0 && pair.tv === 0 && (await fenceOf(db, g.intentId)) === v1 + 1, { before, v0, inTx, after, pair, retryFinal: await fenceOf(db, g.intentId) });
    } catch (e: any) { check(S, 'A3 rolled-back pair', false, String(e.message)); } finally { await finish(f); }
  }

  // ---- A4: the guard rejects any version other than the current one.
  {
    const { g, decisionId } = await fresh();
    const outcomes: Record<string, string> = {};
    for (const label of ['plus1', 'minus1', 'null']) {
      const f = await mk(url);
      try {
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId);
        const supplied = label === 'plus1' ? v + 1 : label === 'minus1' ? v - 1 : null;
        outcomes[label] = await tvInsert(f, g, mi, supplied).then(() => 'INSERTED', (e: any) => /stale or missing/.test(String(e.message)) ? 'REJECTED' : `OTHER:${e.message}`);
      } finally { await finish(f); }
    }
    check(S, 'A4 wrong, stale or missing fenceVersion is rejected', Object.values(outcomes).every(o => o === 'REJECTED') && (await pairCount(g)).tv === 0, outcomes);
  }

  // ---- A5: a fenced write inside F between the fence read and the TV insert fails closed; later writes are legal.
  {
    const { g, decisionId } = await fresh();
    const f = await mk(url);
    let midWrite: string, laterWrite: string;
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId);
      await f.query(`UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`, [g.intentId]);
      midWrite = await tvInsert(f, g, mi, v).then(() => 'INSERTED', (e: any) => /stale or missing/.test(String(e.message)) ? 'REJECTED' : `OTHER:${e.message}`);
    } finally { await finish(f); }
    const f2 = await mk(url);
    try {
      await f2.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f2, g); const v = await lockFence(f2, g.intentId); const mi = await miInsert(f2, g, decisionId); await tvInsert(f2, g, mi, v);
      await f2.query(`UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`, [g.intentId]);
      await f2.query('COMMIT');
      laterWrite = `committed at ${await fenceOf(db, g.intentId)} (stored ${v})`;
      check(S, 'A5 fenced write between fence read and TV insert is rejected; a fenced write after the pair is legal and keeps raising the version', midWrite === 'REJECTED' && (await fenceOf(db, g.intentId)) === v + 2, { midWrite, laterWrite });
    } catch (e: any) { check(S, 'A5 later write', false, String(e.message)); } finally { await finish(f2); }
  }

  // ---- A5b: the post-insert self-verification fails closed if the bump is missing (disabled trigger), so a pair can never
  //           exist with an unadvanced fence.
  {
    const { g, decisionId } = await fresh();
    await db.query('ALTER TABLE "ExternalSignalBrokerDispatchConsumption" DISABLE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump"');
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId);
      const r = await tvInsert(f, g, mi, v).then(() => 'INSERTED', (e: any) => String(e.message));
      check(S, 'A5b consumption without a fence advance is impossible (self-verification)', /did not advance exactly once/.test(r), r);
    } finally { await finish(f); await db.query('ALTER TABLE "ExternalSignalBrokerDispatchConsumption" ENABLE TRIGGER "ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump"'); }
  }

  // ---- A6: concurrency. The competitor is a BrokerOrder for the marked intent. The C2/C3 quarantine rejects it today, so the
  //           probe database disables that one trigger to model the C3C relaxation the fence must already survive. The
  //           competitor's foreign key only KEY SHARE-locks the OrderIntent and it writes neither OrderIntent nor
  //           EntryExposureClaim, so it is a lock-only competitor: only the fence can reveal it to F.
  const quarantineToday = await (async () => { const { g } = await fresh(); return attempt(db, brokerOrderSql, ['bo-q', g.clientOrderId, g.symbol, paperId, g.intentId]); })();
  check(S, 'A6.0 today the quarantine rejects BrokerOrder evidence for a marked intent', !quarantineToday.ok && /quarantined/.test(quarantineToday.message ?? ''), quarantineToday.message);
  await db.query('ALTER TABLE "BrokerOrder" DISABLE TRIGGER "BrokerOrder_external_signal_quarantine"');
  for (const wIso of [RC, SER]) {
    // O1: competitor commits after F's snapshot and before F's validation.
    {
      const { g, decisionId } = await fresh();
      const f = await mk(url), w = await mk(url);
      try {
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await f.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
        await w.query(`BEGIN ISOLATION LEVEL ${wIso}`); const wr = await writeBrokerOrder(w, g, paperId); const wc = await attempt(w, 'COMMIT');
        const lockedRows = await attempt(f, 'SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]);
        const fence = await attempt(f, 'SELECT version FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]);
        check(S, `A6.O1 [W ${wIso}] competitor BrokerOrder committed after F's snapshot: row locks pass, fence lock raises 40001`, wr.ok && wc.ok && lockedRows.ok && fence.code === '40001', { quarantineLetItThrough: wr.ok, writeError: wr.message, rowLocks: lockedRows.ok, fence: fence.code ?? 'ok' });
      } finally { await finish(f, w); }
    }
    // O2: F commits first; a competitor whose snapshot predates F then writes.
    {
      const { g, decisionId } = await fresh();
      const f = await mk(url), w = await mk(url);
      try {
        await w.query(`BEGIN ISOLATION LEVEL ${wIso}`); await w.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, v); await f.query('COMMIT');
        const wr = await writeBrokerOrder(w, g, paperId); const wc = await attempt(w, 'COMMIT');
        const expectFail = wIso === SER;
        check(S, `A6.O2 [W ${wIso}] stale competitor after F committed the pair: ${expectFail ? 'serialization failure' : 'proceeds and raises the fence again'}`,
          expectFail ? (wr.code === '40001' || wc.code === '40001') : (wr.ok && wc.ok && (await fenceOf(db, g.intentId)) === v + 2), { write: wr.code ?? 'ok', commit: wc.code ?? 'ok', fence: await fenceOf(db, g.intentId), v });
      } finally { await finish(f, w); }
    }
    // O3a: the competitor is in flight (uncommitted) when F starts. Its foreign key KEY SHARE-locks the intent, so F waits at the
    //      intent lock, not at the fence; after the competitor commits F's row locks pass (no new row version) and only the
    //      fence lock fails. After a rollback F proceeds and commits the pair.
    for (const competitorCommits of [true, false]) {
      const { g, decisionId } = await fresh();
      const f = await mk(url), w = await mk(url);
      try {
        await w.query(`BEGIN ISOLATION LEVEL ${wIso}`); const wr = await writeBrokerOrder(w, g, paperId);
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await f.query('SELECT 1');
        let done = false; const pending = attempt(f, 'SELECT id FROM "OrderIntent" WHERE id=$1 FOR UPDATE', [g.intentId]).then((r: any) => { done = true; return r; });
        const blocked = await untilBlocked(pidOf(f), () => done);
        await w.query(competitorCommits ? 'COMMIT' : 'ROLLBACK'); const intentLock = await pending;
        const claimLock = intentLock.ok ? await attempt(f, 'SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]) : intentLock;
        const fence = claimLock.ok ? await attempt(f, 'SELECT version::int AS v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]) : claimLock;
        let outcome = fence.ok ? 'proceeded' : fence.code;
        if (fence.ok) { const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, (fence.rows as any[])[0].v); await f.query('COMMIT'); outcome = `committed pair, fence ${await fenceOf(db, g.intentId)}`; }
        check(S, `A6.O3a [W ${wIso}] in-flight competitor: F waits at the intent lock, then ${competitorCommits ? 'is aborted at the fence (40001)' : 'commits the pair after a rollback'}`,
          wr.ok && blocked && intentLock.ok && claimLock.ok && (competitorCommits ? fence.code === '40001' : fence.ok), { blocked, intentLock: intentLock.code ?? 'ok', claimLock: claimLock.code ?? 'ok', outcome });
      } finally { await finish(f, w); }
    }
    // O3b: F already holds the intent, claim and fence; the competitor's write blocks on the foreign key until F commits.
    {
      const { g, decisionId } = await fresh();
      const f = await mk(url), w = await mk(url);
      try {
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId);
        await w.query(`BEGIN ISOLATION LEVEL ${wIso}`);
        let done = false; const pendingWrite = writeBrokerOrder(w, g, paperId).then((r: any) => { done = true; return r; });
        const blocked = await untilBlocked(pidOf(w), () => done);
        const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, v); await f.query('COMMIT');
        const wr = await pendingWrite; const wc = wr.ok ? await attempt(w, 'COMMIT') : wr;
        check(S, `A6.O3b [W ${wIso}] competitor blocked by F's locks proceeds only after F commits: ${wIso === SER ? '40001' : 'ok at the next fence version'}`,
          blocked && (wIso === SER ? (wr.code === '40001' || wc.code === '40001') : (wr.ok && wc.ok && (await fenceOf(db, g.intentId)) === v + 2)), { blocked, write: wr.code ?? 'ok', commit: (wc as any).code ?? 'ok', fence: await fenceOf(db, g.intentId), v });
      } finally { await finish(f, w); }
    }
  }

  // ---- A6c [R5 restated, both halves]: the BrokerOrder bump trigger is DISABLED (negative control for the fence) while the replaced
  //           guard's own evidence check is intact. READ COMMITTED F: the guard reads fresh data after its locks and refuses. A stale
  //           SERIALIZABLE F (snapshot before the competitor's commit): the guard's evidence read is the stale snapshot and the
  //           lock-only competitor leaves the row locks unchanged, so WITHOUT the fence bump the pair is committed next to the
  //           committed BrokerOrder. Neither mechanism is redundant: the guard covers READ COMMITTED, the fence covers SERIALIZABLE.
  for (const fIso of [RC, SER]) {
    await db.query('ALTER TABLE "BrokerOrder" DISABLE TRIGGER "BrokerOrder_dispatch_fence_bump"');
    const { g, decisionId } = await fresh();
    const f = await mk(url), w = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${fIso}`); await f.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
      await w.query(`BEGIN`); await writeBrokerOrder(w, g, paperId); await w.query('COMMIT');
      await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId);
      const outcome = await tvInsert(f, g, mi, v).then(() => 'INSERTED', (e: any) => e.code === '40001' ? '40001' : String(e.message).slice(0, 110));
      const seen = (await db.query(`SELECT count(*)::int n FROM "BrokerOrder" WHERE "clientOrderId"=$1`, [g.clientOrderId])).rows[0].n;
      const pair = (await pairCount(g)).tv;
      if (fIso === RC) check(S, 'A6c.RC [F READ COMMITTED, bump trigger disabled] the guard own evidence check refuses the pair next to committed broker evidence', /TRADINGVIEW_BROKER_EVIDENCE_EXISTS/.test(outcome) && seen === 1 && pair === 0, { outcome, brokerOrders: seen });
      else { await attempt(f, 'COMMIT'); check(S, 'A6c.SER [F stale SERIALIZABLE snapshot, bump trigger disabled] NEGATIVE CONTROL: the pair IS committed next to committed broker evidence (the fence is required for stale snapshots)', outcome === 'INSERTED' && seen === 1 && (await pairCount(g)).tv === 1, { outcome, brokerOrders: seen }); }
    } finally { await finish(f, w); await db.query('ALTER TABLE "BrokerOrder" ENABLE TRIGGER "BrokerOrder_dispatch_fence_bump"'); }
  }

  await db.query('ALTER TABLE "BrokerOrder" ENABLE TRIGGER "BrokerOrder_external_signal_quarantine"');

  // ---- A7: concurrent exposure release against F. The release is the real UPDATE the recovery paths issue.
  const releaseSql = `UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=(now() AT TIME ZONE 'UTC'),"releaseReason"='R4 probe release' WHERE "orderIntentId"=$1`;
  for (const rIso of [RC, SER]) {
    // R starts while F holds the claim and the fence (uncommitted pair): R blocks, then F commits.
    {
      const { g, decisionId } = await fresh();
      const f = await mk(url), r = await mk(url);
      try {
        await r.query(`BEGIN ISOLATION LEVEL ${rIso}`); await r.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, v);
        let done = false; const pending = attempt(r, releaseSql, [g.intentId]).then((x: any) => { done = true; return x; });
        const blocked = await untilBlocked(pidOf(r), () => done);
        await f.query('COMMIT'); const rr = await pending; await r.query('ROLLBACK').catch(() => undefined);
        check(S, `A7.1 [R ${rIso}] release waits for F, then cannot release the consumed claim`, blocked && !rr.ok && !(await lookup(g)), { blocked, release: rr.code ?? rr.message, released: await lookup(g) });
      } finally { await finish(f, r); }
    }
    // F has committed before R starts (R's snapshot may predate it).
    {
      const { g, decisionId } = await fresh();
      const f = await mk(url), r = await mk(url);
      try {
        await r.query(`BEGIN ISOLATION LEVEL ${rIso}`); await r.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, v); await f.query('COMMIT');
        const rr = await attempt(r, releaseSql, [g.intentId]); await r.query('ROLLBACK').catch(() => undefined);
        check(S, `A7.2 [R ${rIso}] release after the pair committed is refused`, !rr.ok && !(await lookup(g)), { release: rr.code ?? rr.message });
      } finally { await finish(f, r); }
    }
  }

  // ---- A7.3/A7.4: the release that ONLY the fence stops. R is SERIALIZABLE with a snapshot older than F's commit and carries
  //                  valid worker-owned not-sent evidence of its own. F locks the claim but writes no new claim version, so R's
  //                  claim UPDATE raises no 40001 and its guard reads the consumption through the old snapshot. R's evidence and
  //                  intent writes bump the fence row, which F's committed pair already advanced: 40001. Control: bump triggers off.
  {
    const notSentSql = `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT c.id,'NOT_SENT_EVIDENCE_RECORDED',jsonb_build_object('classification','NOT_SENT_PRE_DISPATCH','producer','TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY','workerClaimId',$2::int) FROM "EntryExposureClaim" c WHERE c."orderIntentId"=$1`;
    const fencedTriggers: Array<[string, string]> = [['OrderIntent', 'OrderIntent_dispatch_fence_bump'], ['EntryExposureClaim', 'EntryExposureClaim_dispatch_fence_bump'], ['EntryExposureClaimEvent', 'EntryExposureClaimEvent_dispatch_fence_bump'],
      ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump'], ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify']];
    const toggle = async (state: 'DISABLE' | 'ENABLE') => { for (const [table, trigger] of fencedTriggers) await db.query(`ALTER TABLE "${table}" ${state} TRIGGER "${trigger}"`); };
    const staleRelease = async (withFence: boolean, iso: string) => {
      if (!withFence) await toggle('DISABLE');
      const { g, decisionId } = await fresh();
      const r = await mk(url), f = await mk(url);
      try {
        await r.query(`BEGIN ISOLATION LEVEL ${iso}`); await r.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
        await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await lockRows(f, g); const v = await lockFence(f, g.intentId); const mi = await miInsert(f, g, decisionId); await tvInsert(f, g, mi, v); await f.query('COMMIT');
        const evidence = await attempt(r, notSentSql, [g.intentId, g.workerClaimId]);
        const blocked = evidence.ok ? await attempt(r, `UPDATE "OrderIntent" SET status='blocked',"blockReason"='R4 stale release' WHERE id=$1`, [g.intentId]) : evidence;
        const release = blocked.ok ? await attempt(r, releaseSql, [g.intentId]) : blocked;
        const commit = release.ok ? await attempt(r, 'COMMIT') : release;
        return { evidence: evidence.code ?? evidence.message ?? 'ok', intent: blocked.ok ? 'ok' : blocked.code ?? blocked.message, release: release.ok ? 'ok' : release.code ?? release.message, commit: commit.ok ? 'ok' : commit.code ?? commit.message, claimReleased: await lookup(g), pair: await pairCount(g) };
      } finally { await finish(r, f); if (!withFence) await toggle('ENABLE'); }
    };
    const RR = 'REPEATABLE READ';
    for (const iso of [RR, SER]) {
      const guarded = await staleRelease(true, iso);
      check(S, `A7.3 [R ${iso}] a stale releaser holding valid not-sent evidence is stopped (40001) and the consumed claim stays unreleased`, guarded.pair.tv === 1 && guarded.claimReleased === false && [guarded.evidence, guarded.intent, guarded.release, guarded.commit].includes('40001'), guarded);
    }
    const controlRr = await staleRelease(false, RR);
    check(S, 'A7.4 [R REPEATABLE READ] negative control: with the fence bump triggers disabled the same stale releaser RELEASES the consumed claim', controlRr.pair.tv === 1 && controlRr.claimReleased === true, controlRr);
    const controlSer = await staleRelease(false, SER);
    check(S, 'A7.4b [R SERIALIZABLE] control without the fence: recorded outcome (SSI alone may or may not abort this shape)', controlSer.pair.tv === 1, controlSer);
  }

  // ---- A8: the existing evidence fence (D1). It writes a new claim version, so it already protects a SERIALIZABLE F that
  //           locks the claim against an evidence event appended after F's snapshot. It does not cover BrokerOrder,
  //           BrokerActivity, MI decisions or opportunity events (A6 shows BrokerOrder), nor lock-only readers.
  {
    const { g } = await fresh();
    const f = await mk(url), w = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`); await f.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
      await w.query('BEGIN');
      const ins = await attempt(w, `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'DISPATCH_OUTCOME_RECORDED','{}' FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [g.intentId]);
      await w.query('COMMIT');
      const claimLock = await attempt(f, 'SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]);
      check(S, 'A8 [D1] the existing evidence fence makes a SERIALIZABLE claim lock fail (40001) after an evidence event', ins.ok && claimLock.code === '40001', { insert: ins.code ?? 'ok', claimLock: claimLock.code ?? 'ok' });
    } finally { await finish(f, w); }
  }
  void admin;
}

// Section E of the revision-5 real-schema probes: the COMPLETE replaced consumption guard (c3b2-r5-overlay.sql, section D).
// Every case drives DIRECT SQL with NO caller pre-locks and NO service help, the way an attacker, a defective caller or a future
// code path might, under READ COMMITTED and SERIALIZABLE. The caller supplies the CURRENT fence version in every rejected case, so the
// rejection can only come from the guard's own revalidation (a correct fence version is necessary but not sufficient).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { activitySql, brokerOrderSql, plainFence } from './c3b2-r5-common.js';

export async function run(ctx: any) {
  const { db, url, mk, attempt, pidOf, untilBlocked, check, claimed, decided, miInsert, tvInsert, pairCount, fenceOf, paperId, ownerId } = ctx;
  const S = 'consumption';
  const RC = 'READ COMMITTED', SER = 'SERIALIZABLE';
  const finish = async (...cs: any[]) => { for (const c of cs) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); } };
  const fresh = async (options?: any) => { const g = await claimed(); const d = await decided(g, options); return { g, decisionId: d.decisionId as number, d }; };
  const msg = (e: any) => (e?.code === '40001' ? '40001' : String(e?.message ?? e).slice(0, 140));
  const hasQuarantine = async (state: 'DISABLE' | 'ENABLE') => { for (const t of ['BrokerOrder', 'BrokerActivity']) await db.query(`ALTER TABLE "${t}" ${state} TRIGGER "${t}_external_signal_quarantine"`); };
  /** Direct SQL pair: plain (unlocked) fence read, MI insert, optional hook, TV insert. No pre-locks. */
  async function directPair(g: any, decisionId: number, iso: string, hook?: () => Promise<void>, supply?: (v: number) => number | null) {
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${iso}`);
      const v = (await plainFence(f, g.intentId))!;
      // The hook runs AFTER F's snapshot / fence read and BEFORE the MI insert: since the MI insert now takes the canonical lock prelude, a mutation of a
      // row F has already locked would simply wait for F, so the interesting race is the one that lands between the snapshot and the locks.
      if (hook) await hook();
      const miId = await miInsert(f, g, decisionId);
      const current = supply ? supply(v) : v;
      const r = await tvInsert(f, g, miId, current).then(() => 'INSERTED', (e: any) => msg(e));
      if (r === 'INSERTED') await f.query('COMMIT');
      return r;
    } catch (e: any) { return msg(e); } finally { await finish(f); }
  }
  /** Committed mutation by an unrelated session with every trigger skipped (models drift, corruption or a race the triggers would normally mediate). */
  async function mutate(sql: string, params: unknown[] = []) {
    await db.query('BEGIN'); try { await db.query(`SET LOCAL session_replication_role='replica'`); await db.query(sql, params); await db.query('COMMIT'); } catch (e) { await db.query('ROLLBACK'); throw e; }
  }
  const expectRejected = (outcome: string, re: RegExp) => outcome !== 'INSERTED' && re.test(outcome);

  // ---- E0: the revision-4 guard (fence equality only) next to committed BrokerOrder evidence COMMITS the pair. Negative control.
  {
    const original = (await db.query(`SELECT pg_get_functiondef('external_signal_broker_consumption_guard()'::regprocedure) AS def`)).rows[0].def as string;
    await db.query(`CREATE OR REPLACE FUNCTION external_signal_broker_consumption_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE v bigint; BEGIN
        SELECT version INTO v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = NEW."orderIntentId" FOR UPDATE;
        IF v IS NULL OR NEW."fenceVersion" IS NULL OR NEW."fenceVersion" <> v THEN RAISE EXCEPTION 'TradingView dispatch fence version is stale or missing (supplied %, current %)', NEW."fenceVersion", v; END IF;
        NEW."consumedAt" := statement_timestamp(); NEW."authorizedAt" := clock_timestamp(); NEW."authorizationDeadlineAt" := clock_timestamp() + interval '30 seconds'; RETURN NEW; END $$`);
    await hasQuarantine('DISABLE');
    try {
      const { g, decisionId } = await fresh();
      const sec = g.securityId as number;
      const w = await attempt(db, brokerOrderSql, [g.intentId, `bo-${g.intentId}-e0`, g.clientOrderId, g.symbol, paperId, sec]);
      const outcome = await directPair(g, decisionId, RC);
      check(S, 'E0 NEGATIVE CONTROL: the fence-only guard (revision 4) commits a valid-looking pair next to committed BrokerOrder evidence under READ COMMITTED direct SQL', w.ok && outcome === 'INSERTED' && (await pairCount(g)).tv === 1, { evidenceWritten: w.ok, outcome });
    } finally { await db.query(original); await hasQuarantine('ENABLE'); }
  }

  // ---- E1: evidence committed BEFORE F reads the (already bumped) fence. Both isolation levels, no pre-locks.
  await hasQuarantine('DISABLE'); // models the C3C relaxation: the guard, not the quarantine, must be the barrier
  try {
    const kinds: Array<[string, (g: any) => Promise<any>, RegExp]> = [
      ['BrokerOrder with the intent id', g => attempt(db, brokerOrderSql, [g.intentId, `bo-${g.intentId}-a`, g.clientOrderId, g.symbol, paperId, g.securityId]), /BROKER_EVIDENCE_EXISTS/],
      ['BrokerOrder under ANOTHER intent carrying the marked clientOrderId (same account)', async g => {
        const other = (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('legacy','SEED','buy','market','day','received',$1,'{}',$2,now(),now()) RETURNING id`, [`e1-other-${Math.random()}`, paperId])).rows[0].id;
        return attempt(db, brokerOrderSql, [other, `bo-${g.intentId}-b`, g.clientOrderId, g.symbol, paperId, g.securityId]);
      }, /BROKER_EVIDENCE_EXISTS/],
      ['BrokerActivity with the intent id and no order id', g => attempt(db, activitySql, [`ba-${g.intentId}-a`, null, g.intentId, null, paperId, 'paper', g.symbol]), /BROKER_EVIDENCE_EXISTS/],
      ['claim event ADAPTER_INVOCATION_STARTED', g => attempt(db, `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'ADAPTER_INVOCATION_STARTED',$2::jsonb FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [g.intentId, JSON.stringify({ workerClaimId: g.workerClaimId })]), /CONTRADICTORY_EVIDENCE/],
      ['claim event DISPATCH_OUTCOME_RECORDED', g => attempt(db, `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'DISPATCH_OUTCOME_RECORDED','{}' FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [g.intentId]), /CONTRADICTORY_EVIDENCE/],
      ['claim event BROKER_DELIVERY_UNCERTAIN', g => attempt(db, `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'BROKER_DELIVERY_UNCERTAIN','{}' FROM "EntryExposureClaim" WHERE "orderIntentId"=$1`, [g.intentId]), /CONTRADICTORY_EVIDENCE/],
      ['claim event NOT_SENT_EVIDENCE_RECORDED (a contradictory lifecycle)', g => attempt(db, `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT c.id,'NOT_SENT_EVIDENCE_RECORDED',jsonb_build_object('classification','NOT_SENT_PRE_DISPATCH','producer','TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY','workerClaimId',$2::int) FROM "EntryExposureClaim" c WHERE c."orderIntentId"=$1`, [g.intentId, g.workerClaimId]), /CONTRADICTORY_EVIDENCE/],
    ];
    for (const iso of [RC, SER]) for (const [label, write, re] of kinds) {
      const { g, decisionId } = await fresh();
      const w = await write(g);
      const before = await fenceOf(db, g.intentId);
      const outcome = await directPair(g, decisionId, iso); // supplies the CURRENT fence version
      check(S, `E1 [F ${iso}] evidence committed before F (${label}) rejects the pair although the supplied fence version is current`, w.ok && expectRejected(outcome, re) && (await pairCount(g)).tv === 0 && (await pairCount(g)).mi === 0, { evidenceWritten: w.ok, writeError: w.message, fenceAtFRead: before, outcome });
    }
  } finally { await hasQuarantine('ENABLE'); }

  // ---- E2: stale or contradictory world state, current fence version supplied. Mutations commit between the MI insert and the TV insert.
  {
    type Case = { label: string; pre?: (g: any) => Promise<void>; mutateWith?: (g: any, d: any) => Promise<void>; re: RegExp; useOtherWorkerClaim?: boolean; isoExpect?: Record<string, RegExp> };
    const cases: Case[] = [
      { label: 'account kill switch enabled', mutateWith: g => mutate(`UPDATE "TradingAccount" SET "killSwitchEnabled"=true,"tradingEnabled"=false WHERE id=$1`, [paperId]).then(() => undefined), re: /ACCOUNT_NOT_ELIGIBLE/ },
      { label: 'account status PAUSED', mutateWith: g => mutate(`UPDATE "TradingAccount" SET status='PAUSED',"tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=$1`, [paperId]).then(() => undefined), re: /ACCOUNT_NOT_ELIGIBLE/ },
      { label: 'account tradingBlocked', mutateWith: g => mutate(`UPDATE "TradingAccount" SET "tradingBlocked"=true WHERE id=$1`, [paperId]).then(() => undefined), re: /ACCOUNT_NOT_ELIGIBLE/ },
      { label: 'assignment entries disabled', mutateWith: g => mutate(`UPDATE "TradingAccountSubscription" SET "entriesEnabled"=false WHERE id=$1`, [g.assignmentId]).then(() => undefined), re: /ASSIGNMENT_NOT_ELIGIBLE/ },
      { label: 'entry signal receipt expired (200 s old)', pre: g => mutate(`ALTER TABLE "Signal" DISABLE TRIGGER USER`).then(() => mutate(`UPDATE "Signal" SET "receivedAt"=clock_timestamp()-interval '200 seconds' WHERE id=(SELECT "entrySignalId" FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1)`, [g.intentId])).then(() => db.query(`ALTER TABLE "Signal" ENABLE TRIGGER USER`)).then(() => undefined), re: /ENTRY_SIGNAL_EXPIRED/ },
      { label: 'historical signal (receivedAt NULL) is ineligible for broker authorization', pre: g => mutate(`ALTER TABLE "Signal" DISABLE TRIGGER USER`).then(() => mutate(`UPDATE "Signal" SET "receivedAt"=NULL WHERE id=(SELECT "entrySignalId" FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1)`, [g.intentId])).then(() => db.query(`ALTER TABLE "Signal" ENABLE TRIGGER USER`)).then(() => undefined), re: /ENTRY_SIGNAL_EXPIRED/ },
      { label: 'accepted EXIT pending on the account cycle', mutateWith: g => mutate(`UPDATE "ExternalSignalTradeCycleAccount" SET "pendingExitAcceptedAt"=now() WHERE id=$1`, [g.accountCycleId]).then(() => undefined), re: /EXIT_ACCEPTED/ },
      { label: 'exposure claim already released', mutateWith: g => mutate(`UPDATE "EntryExposureClaim" SET status='RELEASED',"releasedAt"=now() AT TIME ZONE 'UTC',"releaseReason"='e2' WHERE "orderIntentId"=$1`, [g.intentId]).then(() => undefined), re: /CLAIM_STATE|INTENT_NOT_EXECUTABLE/ },
      { label: 'intent no longer submitting', mutateWith: g => mutate(`UPDATE "OrderIntent" SET status='blocked' WHERE id=$1`, [g.intentId]).then(() => undefined), re: /CLAIM_STATE|INTENT_NOT_EXECUTABLE/ },
      { label: 'worker claim belongs to another intent', useOtherWorkerClaim: true, re: /evidence graph is inconsistent \(worker claim\)/ },
      { label: 'frozen MI obligation drifted from the decision (authorization fingerprint)', mutateWith: g => mutate(`UPDATE "OrderIntentMarketPolicyEnforcementObligation" SET "authorizationFingerprint"=repeat('f',64) WHERE "orderIntentId"=$1`, [g.intentId]).then(() => undefined), re: /MI_OBLIGATION_MISMATCH/ },
      { label: 'frozen MI obligation belongs to a different security', mutateWith: g => mutate(`UPDATE "OrderIntentMarketPolicyEnforcementObligation" SET "securityId"="securityId"+100000 WHERE "orderIntentId"=$1`, [g.intentId]).then(() => undefined), re: /MI_OBLIGATION_MISMATCH/ },
      { label: 'TradingView authorization revoked', mutateWith: g => mutate(`UPDATE "ExternalSignalEntryExecutionAuthorization" SET status='REVOKED',"revokedAt"=now(),"revokedByUserId"=$2,"revocationReason"='e2' WHERE id=$1`, [g.authorizationIdFor, ownerId]).then(() => undefined), re: /AUTHORIZATION_NOT_EFFECTIVE/ },
      { label: 'dispatch state version advanced', mutateWith: () => mutate(`UPDATE "ExternalSignalBrokerDispatchState" SET version=version+1 WHERE id=1`).then(() => undefined), re: /DISPATCH_STATE_CHANGED|evidence graph is inconsistent/ },
    ];
    for (const iso of [RC, SER]) for (const cs of cases) {
      const { g, decisionId } = await fresh();
      (g as any).assignmentId = await ctx.assignmentOf(g.intentId);
      (g as any).authorizationIdFor = (await db.query('SELECT "authorizationId" AS a FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1', [g.obligationId])).rows[0].a;
      let target = g;
      if (cs.useOtherWorkerClaim) { const other = await claimed(); target = { ...g, workerClaimId: other.workerClaimId }; }
      if (cs.pre) await cs.pre(g);
      const outcome = await directPair(target, decisionId, iso, cs.mutateWith ? () => cs.mutateWith!(g, undefined) : undefined);
      const pair = await pairCount(g);
      // Restore shared account/dispatch state the mutation touched, so later cases start clean.
      await mutate(`UPDATE "TradingAccount" SET "killSwitchEnabled"=false, "tradingEnabled"=true, status='ACTIVE', "tradingBlocked"=false WHERE id=$1`, [paperId]);
      const dsv = (await db.query('SELECT version FROM "ExternalSignalBrokerDispatchState" WHERE id=1')).rows[0].version;
      void dsv;
      // SERIALIZABLE F holds a snapshot older than the committed mutation: a locked row changed after the snapshot is 40001, which is
      // a (retryable, fail-closed) rejection too. The pair must not exist either way.
      const rejected = outcome !== 'INSERTED' && (cs.re.test(outcome) || (iso === SER && outcome === '40001'));
      check(S, `E2 [F ${iso}] ${cs.label}: pair rejected with the CURRENT fence version supplied`, rejected && pair.tv === 0, { outcome, pair });
      if (/dispatch state version advanced/.test(cs.label)) { // restore the version F validates against for the remaining cases
        await mutate(`UPDATE "ExternalSignalBrokerDispatchState" SET version=version-1 WHERE id=1`);
      }
    }
  }

  // ---- E2b: the decision is no longer the latest (a newer decision superseded it). Seeded with triggers off for the INSERT only.
  for (const iso of [RC, SER]) {
    const { g, decisionId } = await fresh();
    const outcome = await directPair(g, decisionId, iso, async () => {
      await decided(g, { dispatchSequence: 2 });
      // The seeded decision INSERT skips every trigger, including its fence bump. The bump is modeled by a fenced OrderIntent write (the
      // same one-row fence advance the real decision-insert trigger performs). The real chain remains proof obligation 11.2-4.
      if (iso === SER) await db.query('UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1', [g.intentId]); // READ COMMITTED: no proxy, the guard's own latest-decision check must fire
    });
    check(S, `E2b [F ${iso}] a newer MI decision supersedes the consumed one: pair rejected (decision seeded with triggers off; its bump modeled by a fenced intent write)`, outcome !== 'INSERTED' && (/DECISION_SUPERSEDED/.test(outcome) || (iso === SER && outcome === '40001')) && (await pairCount(g)).tv === 0, { outcome });
  }

  // ---- E3: evidence IN FLIGHT during F (direct SQL, no pre-locks). The writer inserts a BrokerOrder and stays open.
  await hasQuarantine('DISABLE');
  try {
    for (const fIso of [RC, SER]) for (const writerCommits of [true, false]) {
      const { g, decisionId } = await fresh();
      const w = await mk(url), f = await mk(url);
      try {
        await w.query('BEGIN'); const wr = await attempt(w, brokerOrderSql, [g.intentId, `bo-${g.intentId}-e3`, g.clientOrderId, g.symbol, paperId, g.securityId]);
        await f.query(`BEGIN ISOLATION LEVEL ${fIso}`);
        const v = (await plainFence(f, g.intentId))!;
        // The MI consumption insert now runs the canonical lock prelude, so IT is where F first meets the writer's KEY SHARE on the intent.
        let done = false; const pending = (async () => { const miId = await miInsert(f, g, decisionId); return tvInsert(f, g, miId, v); })().then(() => 'INSERTED', (e: any) => msg(e)).then(r => { done = true; return r; });
        const blocked = await untilBlocked(pidOf(f), () => done);
        await w.query(writerCommits ? 'COMMIT' : 'ROLLBACK');
        const outcome = await pending;
        if (outcome === 'INSERTED') await f.query('COMMIT');
        const pair = await pairCount(g);
        const expected = writerCommits ? (fIso === RC ? /BROKER_EVIDENCE_EXISTS|stale or missing/.test(outcome) : outcome === '40001') && pair.tv === 0 : outcome === 'INSERTED' && pair.tv === 1;
        check(S, `E3 [F ${fIso}] BrokerOrder in flight when F runs; the writer ${writerCommits ? 'commits' : 'rolls back'}: F waits on the intent lock, then ${writerCommits ? (fIso === RC ? 'is refused (the fence moved while F waited, or the evidence check)' : 'fails 40001') : 'commits the pair'}`, wr.ok && blocked && expected, { blocked, outcome, pair });
      } finally { await finish(w, f); }
    }

    // ---- E4: F commits first; a writer whose snapshot predates F then writes evidence. Evidence after the pair is legitimate (it is what a
    //          send produces); the writer's isolation decides only whether it is stale-aborted. The pair and the exposure stay intact.
    for (const wIso of [RC, SER]) {
      const { g, decisionId } = await fresh();
      const w = await mk(url);
      try {
        await w.query(`BEGIN ISOLATION LEVEL ${wIso}`); await w.query('SELECT id FROM "OrderIntent" WHERE id=$1', [g.intentId]);
        const first = await directPair(g, decisionId, SER);
        const wr = await attempt(w, brokerOrderSql, [g.intentId, `bo-${g.intentId}-e4`, g.clientOrderId, g.symbol, paperId, g.securityId]); const wc = wr.ok ? await attempt(w, 'COMMIT') : wr;
        const pair = await pairCount(g);
        check(S, `E4 [W ${wIso}] F commits first, a stale writer follows: pair intact${wIso === SER ? ', writer aborted (40001)' : ', evidence recorded at a later fence version'}`, first === 'INSERTED' && pair.tv === 1 && (wIso === SER ? (wr.code === '40001' || wc.code === '40001') : wr.ok && wc.ok), { first, write: wr.code ?? 'ok', commit: wc.code ?? 'ok', pair });
      } finally { await finish(w); }
    }
  } finally { await hasQuarantine('ENABLE'); }

  // ---- E5: success path under both isolation levels with direct SQL and no pre-locks; stamps; caller-supplied stamps rejected.
  for (const iso of [RC, SER]) {
    const { g, decisionId } = await fresh();
    const v0 = await fenceOf(db, g.intentId);
    const outcome = await directPair(g, decisionId, iso);
    const row = (await db.query(`SELECT t."fenceVersion"::int AS fv, t."authorizedAt", t."authorizationDeadlineAt", s."receivedAt", extract(epoch FROM t."authorizationDeadlineAt" - t."authorizedAt") AS window_s, extract(epoch FROM (s."receivedAt" + interval '120 seconds') - t."authorizationDeadlineAt") AS slack_s
      FROM "ExternalSignalBrokerDispatchConsumption" t JOIN "ExternalSignalEntryExecutionObligation" o ON o.id=t."executionObligationId" JOIN "Signal" s ON s.id=o."entrySignalId" WHERE t."orderIntentId"=$1`, [g.intentId])).rows[0];
    check(S, `E5 [F ${iso}] direct SQL with no pre-locks commits the pair; fenceVersion=v, fence=v+1 (+ later fenced writes), deadline = least(receipt+120s, authorizedAt+30s)`, outcome === 'INSERTED' && row?.fv === v0 && (await fenceOf(db, g.intentId))! >= v0 + 1 && Number(row.window_s) <= 30.001 && Number(row.slack_s) >= -0.001, { outcome, v0, row });
  }
  {
    const { g, decisionId } = await fresh();
    const f = await mk(url);
    try {
      await f.query('BEGIN'); const v = (await plainFence(f, g.intentId))!; const miId = await miInsert(f, g, decisionId);
      const r = await f.query(`INSERT INTO "ExternalSignalBrokerDispatchConsumption" ("orderIntentId","executionObligationId","workerClaimId","marketPolicyDispatchConsumptionId","rolloutGenerationId","executionAuthorizationId","dispatchStateVersion","clientOrderId","fenceVersion","authorizedAt","authorizationDeadlineAt","evidenceJson")
        SELECT $1,$2,$3,$4,o."rolloutGenerationId",o."authorizationId",$5,$6,$7,now()+interval '1 day',now()+interval '1 day','{}' FROM "ExternalSignalEntryExecutionObligation" o WHERE o.id=$2`,
        [g.intentId, g.obligationId, g.workerClaimId, miId, await ctx.dispatchStateVersion(), g.clientOrderId, v]).then(() => 'INSERTED', (e: any) => msg(e));
      check(S, 'E5b caller-supplied authorizedAt / authorizationDeadlineAt are rejected (database-stamped only)', /database-stamped/.test(r), r);
    } finally { await finish(f); }
  }
  void ownerId;
}

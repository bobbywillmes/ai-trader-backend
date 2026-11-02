// Section O of the revision-5 real-schema probes: lock order.
//  O1  refuseCandidate (src/services/external-signal-entry-admission.service.ts:27) updates the account cycle BEFORE its trigger locks the
//      parent cycle, while EXIT correlation and entry recovery lock cycle THEN account cycle. Both queue orders, current and corrected.
//      The refusal is replayed as the same statement shape on raw connections: the function is not exported, and changing production
//      code is outside this design-only revision.
//  O2  the COMPLETE consumption guard (it takes the canonical lock sequence itself) against the REAL Market Intelligence revoke service.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function run(ctx: any) {
  const { db, url, mk, attempt, pidOf, untilBlocked, sleep, check, results, claimed, decided, miInsert, tvInsert, pairCount, fenceOf, mi, assignmentOf, paperId } = ctx;
  const S = 'order';
  const finish = async (...cs: any[]) => { for (const c of cs) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); } };
  const settle = async <T>(p: Promise<T>) => p.then(v => ({ ok: true as const, v }), (e: any) => ({ ok: false as const, code: e.code as string | undefined, message: String(e.message).slice(0, 100) }));

  // ---- O1. Each run uses a fresh graph so the rows are uncontended.
  const refusalUpdate = `UPDATE "ExternalSignalTradeCycleAccount" SET "updatedAt"=now() WHERE id=$1`;
  async function exitVsRefusal(variant: 'current' | 'corrected', order: 'EXIT_FIRST' | 'REFUSAL_FIRST') {
    const g = await claimed();
    const ids = (await db.query('SELECT "sourceCycleId" AS cycle, "accountCycleId" AS account FROM "ExternalSignalEntryExecutionObligation" WHERE id=$1', [g.obligationId])).rows[0];
    const exit = await mk(url), refuse = await mk(url);
    try {
      await exit.query('BEGIN'); await refuse.query('BEGIN');
      const exitFirstLock = async () => exit.query('SELECT id FROM "ExternalSignalTradeCycle" WHERE id=$1 FOR UPDATE', [ids.cycle]);       // correlation.ts:30..38 lock the cycle first
      const exitSecondLock = () => exit.query('SELECT id FROM "ExternalSignalTradeCycleAccount" WHERE id=$1 FOR UPDATE', [ids.account]);   // then each account cycle (:38)
      const refusal = async () => {
        if (variant === 'corrected') await refuse.query('SELECT id FROM "ExternalSignalTradeCycle" WHERE id=$1 FOR UPDATE', [ids.cycle]);   // parent first
        return refuse.query(refusalUpdate, [ids.account]);                                                                                   // then the child (its trigger finds the parent held)
      };
      let refusalResult: any, exitResult: any;
      if (order === 'EXIT_FIRST') {
        await exitFirstLock();
        let doneR = false; const pr = settle(refusal()).then(r => { doneR = true; return r; });
        const blocked = await untilBlocked(pidOf(refuse), () => doneR);
        let doneE = false; const pe = settle(exitSecondLock()).then(r => { doneE = true; return r; });
        // deadlock_timeout is 1 s: one of the two is aborted with 40P01 when the cycle exists. EXIT finishes (commit or rollback) first;
        // only then can a refusal that is queued behind its cycle lock proceed.
        exitResult = await pe;
        if (exitResult.ok) await exit.query('COMMIT').catch(() => undefined); else await exit.query('ROLLBACK').catch(() => undefined);
        refusalResult = await pr;
        if (refusalResult.ok) await refuse.query('COMMIT').catch(() => undefined);
        return { blocked, refusal: refusalResult.ok ? 'ok' : refusalResult.code, exit: exitResult.ok ? 'ok' : exitResult.code };
      }
      // REFUSAL_FIRST: the refusal starts first; the EXIT correlation then queues behind it.
      refusalResult = await settle(refusal());
      let doneE = false; const pe = settle((async () => { await exitFirstLock(); return exitSecondLock(); })()).then(r => { doneE = true; return r; });
      const blocked = await untilBlocked(pidOf(exit), () => doneE);
      if (refusalResult.ok) await refuse.query('COMMIT').catch(() => undefined);
      exitResult = await pe;
      if (exitResult.ok) await exit.query('COMMIT').catch(() => undefined);
      return { blocked, refusal: refusalResult.ok ? 'ok' : refusalResult.code, exit: exitResult.ok ? 'ok' : exitResult.code };
    } finally { await finish(exit, refuse); }
  }
  const matrix: Record<string, any> = {};
  for (const variant of ['current', 'corrected'] as const) for (const order of ['EXIT_FIRST', 'REFUSAL_FIRST'] as const) matrix[`${variant} / ${order}`] = await exitVsRefusal(variant, order);
  const deadlocks = (r: any) => [r.refusal, r.exit].filter(x => x === '40P01').length;
  (results as any).refusalLockMatrix = matrix;
  check(S, 'O1a CURRENT refuseCandidate (update the account cycle, its trigger then locks the parent) deadlocks (40P01) against EXIT correlation when EXIT holds the cycle first', deadlocks(matrix['current / EXIT_FIRST']) === 1, matrix['current / EXIT_FIRST']);
  check(S, 'O1b CURRENT refuseCandidate in the other queue order (refusal first) does not deadlock: the inversion is order dependent, so it hides in tests', deadlocks(matrix['current / REFUSAL_FIRST']) === 0 && matrix['current / REFUSAL_FIRST'].refusal === 'ok' && matrix['current / REFUSAL_FIRST'].exit === 'ok', matrix['current / REFUSAL_FIRST']);
  check(S, 'O1c CORRECTED refuseCandidate (lock the parent cycle, then the account cycle) never deadlocks in either queue order', deadlocks(matrix['corrected / EXIT_FIRST']) === 0 && deadlocks(matrix['corrected / REFUSAL_FIRST']) === 0 && Object.entries(matrix).filter(([k]) => k.startsWith('corrected')).every(([, r]: any) => r.refusal === 'ok' && r.exit === 'ok'), { exitFirst: matrix['corrected / EXIT_FIRST'], refusalFirst: matrix['corrected / REFUSAL_FIRST'] });

  // ---- O2. The COMPLETE guard (and the MI-consumption lock prelude) against the REAL Market Intelligence revoke service, both queue
  //          orders. No caller pre-locks: the prelude trigger/function takes the canonical order itself. H holds the assignment row (an MI
  //          operation in flight); whichever of {TradingView pair, revoke service} queues first is granted first when H releases.
  const miWaiting = async () => (await db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='r5-prisma' AND state='active' AND wait_event_type='Lock'`)).rows[0].n > 0;
  const untilMiWaiting = async () => { for (let i = 0; i < 600; i += 1) { if (await miWaiting()) return true; await sleep(10); } return false; };
  const O2 = async (order: 'PAIR_QUEUES_FIRST' | 'REVOKE_QUEUES_FIRST', preludeEnabled: boolean) => {
    if (!preludeEnabled) await db.query('ALTER TABLE "MarketPolicyBrokerDispatchConsumption" DISABLE TRIGGER "BrokerDispatchConsumption_a_lock_prelude"');
    const g = await claimed(); const d = await decided(g);
    const assignmentId = await assignmentOf(g.intentId);
    const h = await mk(url), f = await mk(url);
    let revokePromise: Promise<any> | undefined; let pairPromise: Promise<any> | undefined; let pairBlocked = false;
    try {
      await h.query('BEGIN'); await h.query('SELECT id FROM "TradingAccountSubscription" WHERE id=$1 FOR UPDATE', [assignmentId]);
      await f.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const v = (await f.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [g.intentId])).rows[0].v;
      const startPair = async () => { let done = false; pairPromise = settle((async () => { const miId = await miInsert(f, g, d.decisionId); return tvInsert(f, g, miId, v); })()).then(r => { done = true; return r; }); pairBlocked = await untilBlocked(pidOf(f), () => done); };
      const startRevoke = async () => { revokePromise = settle(mi.revoke(assignmentId, d.authorizationId)); await untilMiWaiting(); };
      if (order === 'PAIR_QUEUES_FIRST') { await startPair(); await startRevoke(); } else { await startRevoke(); await startPair(); }
      await h.query('COMMIT');
      const tv: any = await pairPromise; if (tv.ok) await f.query('COMMIT').catch(() => undefined); else await f.query('ROLLBACK').catch(() => undefined);
      const rv: any = await revokePromise;
      const deadlock = [tv.code, rv.code].includes('40P01') || /deadlock/i.test(String(rv.message));
      const pair = await pairCount(g);
      const authStatus = (await db.query('SELECT status FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE id=$1', [d.authorizationId])).rows[0].status;
      return { deadlock, pair, revoke: rv, tv, pairBlocked, authStatus };
    } finally { await finish(h, f); await Promise.allSettled([pairPromise, revokePromise].filter(Boolean) as Promise<any>[]); if (!preludeEnabled) await db.query('ALTER TABLE "MarketPolicyBrokerDispatchConsumption" ENABLE TRIGGER "BrokerDispatchConsumption_a_lock_prelude"'); }
  };
  for (const order of ['PAIR_QUEUES_FIRST', 'REVOKE_QUEUES_FIRST'] as const) {
    const r: any = await O2(order, true);
    check(S, `O2 [${order}] pair (no caller pre-locks) against the real MI revoke service: no deadlock; the outcome is consistent (pair committed XOR refused; the revoke is applied, never lost)`, !r.deadlock && (r.tv.ok ? r.pair.tv === 1 : r.pair.tv === 0) && r.revoke.ok && r.authStatus === 'REVOKED', { pairWaitedOnAssignment: r.pairBlocked, pair: r.tv.ok ? 'COMMITTED' : `${r.tv.code} ${r.tv.message}`, revoke: r.revoke.ok ? 'REVOKED' : `${r.revoke.code} ${r.revoke.message}`, miAuthorizationStatus: r.authStatus, pairRows: r.pair });
  }
  {
    const r: any = await O2('REVOKE_QUEUES_FIRST', false);
    check(S, 'O2c NEGATIVE CONTROL [REVOKE_QUEUES_FIRST, MI-consumption lock prelude trigger disabled]: the MI consumption insert takes the MI authorization lock before the guard reaches the assignment, and the real MI revoke deadlocks with it (40P01): why the prelude trigger exists', r.deadlock === true, { pair: r.tv.ok ? 'COMMITTED' : `${r.tv.code} ${r.tv.message}`, revoke: r.revoke.ok ? 'REVOKED' : `${r.revoke.code} ${r.revoke.message}` });
  }
  void attempt; void fenceOf; void paperId;
}

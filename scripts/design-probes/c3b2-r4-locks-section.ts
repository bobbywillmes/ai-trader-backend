// Section C of the revision-4 real-schema probes: the Market Intelligence / TradingView lock inversion, implicit trigger
// locks and the corrected identity-lock policy (see c3b2-r4-real-schema-probes.ts). Market Intelligence grant and revoke run
// through the production services; the TradingView side uses the real worker-claim guard.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function run(ctx: any) {
  const { db, url, mk, attempt, pidOf, untilBlocked, sleep, check, results, admitted, claimed, decided, miInsert, tvInsert, fenceOf, dispatchStateVersion, mi, assignmentOf, paperId, ownerId } = ctx;
  const S = 'locks';
  const SER = 'SERIALIZABLE';
  const finish = async (...cs: any[]) => { for (const c of cs) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); } };

  // ---- C0: every locking / writing statement of every trigger function on the contested tables, from the migrated catalog.
  const triggerRows = (await db.query(`
    SELECT c.relname AS "table", t.tgname AS trigger, p.proname AS fn, pg_get_functiondef(p.oid) AS body,
           CASE WHEN t.tgtype & 2 > 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`,
  [['TradingAccount', 'TradingAccountSubscription', 'Subscription', 'Security', 'TradingAccountAllocation', 'Strategy', 'ExitProfile', 'AssignmentMarketPolicyEnforcementAuthorization',
    'ExternalSignalEntryExecutionAuthorization', 'ExternalSignalBrokerWorkerClaim', 'ExternalSignalBrokerDispatchConsumption', 'MarketPolicyBrokerDispatchConsumption', 'EntryExposureClaim', 'EntryExposureClaimEvent', 'OrderIntent',
    'ExternalSignalTradeCycleAccount', 'Signal', 'MarketPolicyBrokerDispatchDecision', 'OrderIntentMarketPolicyEnforcementObligation']])).rows;
  const statements: Record<string, string[]> = {};
  for (const row of triggerRows) {
    const lines = String(row.body).split('\n').flatMap((line: string, index: number) => {
      const hit = /pg_advisory|FOR (UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)|^\s*(UPDATE|INSERT INTO|DELETE FROM) "/i.test(line);
      return hit ? [`${index}: ${line.trim().replace(/\s+/g, ' ').slice(0, 170)}`] : [];
    });
    if (lines.length) (statements[`${row.table}.${row.trigger} [${row.timing}] ${row.fn}`] = lines);
  }
  results.lockStatements = statements;
  check(S, 'C0 trigger lock statements extracted from the migrated catalog', Object.keys(statements).length >= 10, { triggers: Object.keys(statements).length });

  // ---- Instruments: row-lock/write tracing for the current transaction (pgrowlocks + xmin) and MI-service wait detection.
  const TABLES = ['TradingAccount', 'TradingAccountSubscription', 'Subscription', 'Security', 'Strategy', 'ExitProfile', 'TradingAccountAllocation', 'ExternalSignalSource', 'StrategySignalBinding', 'StrategySignalRevision',
    'ExternalSignalExecutionRolloutGeneration', 'ExternalSignalExecutionRolloutState', 'ExternalSignalBrokerDispatchState', 'ExternalSignalTradeCycle', 'ExternalSignalTradeCycleAccount', 'ExternalSignalEntryExecutionAuthorization',
    'ExternalSignalEntryExecutionObligation', 'ExternalSignalBrokerWorkerClaim', 'OrderIntent', 'EntryExposureClaim', 'EntryExposureClaimEvent', 'ExternalSignalDispatchFence', 'Signal', 'SignalRoute', 'SignalRoutingRun',
    'AssignmentMarketPolicyEnforcementAuthorization', 'AssignmentMarketPolicyEnrollmentGeneration', 'MarketPolicyEnforcementRuntimeRollout', 'User', 'MarketPolicyBrokerDispatchDecision', 'OrderIntentMarketPolicyEnforcementObligation',
    'MarketPolicyBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption', 'StrategyMarketPolicyRevision'];
  const short = (m: string) => m.replace('For ', '').replace('No Key Update', 'NoKeyUpdate').replace('Key Share', 'KeyShare').replace('Update', 'Update');
  async function trace(c: any, selfOnly = true) {
    const xid = (await c.query(`SELECT (pg_current_xact_id()::text::bigint % 4294967296)::text AS x`)).rows[0].x as string;
    const out: Record<string, string[]> = {};
    for (const table of TABLES) {
      const locks = await c.query(`SELECT locked_row, modes FROM pgrowlocks($1) WHERE locker::text = $2 OR $2 = ANY(xids::text[])`, [`"${table}"`, xid]);
      for (const l of locks.rows) {
        const key = (await c.query(`SELECT coalesce(to_jsonb(t)->>'id', to_jsonb(t)->>'orderIntentId') AS k FROM "${table}" t WHERE t.ctid = $1::tid`, [l.locked_row])).rows[0]?.k;
        (out[table] ??= []).push(`#${key}:${(l.modes as string[]).map(short).join('+')}`);
      }
      const written = await c.query(`SELECT coalesce(to_jsonb(t)->>'id', to_jsonb(t)->>'orderIntentId') AS k FROM "${table}" t WHERE t.xmin::text = $1`, [xid]);
      for (const w of written.rows) (out[table] ??= []).push(`#${w.k}:written`);
    }
    void selfOnly;
    return out;
  }
  const flat = (t: Record<string, string[]>) => Object.entries(t).flatMap(([table, rows]) => rows.map(r => `${table}${r}`));
  const miBlocked = async () => (await db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='r4-prisma' AND state='active' AND wait_event_type='Lock'`)).rows[0].n > 0;
  const untilMiBlocked = async () => { for (let i = 0; i < 600; i += 1) { if (await miBlocked()) return true; await sleep(10); } return false; };

  const prepare = async () => { // an admitted, still-pending intent whose worker claim has not been taken
    const g = await admitted(); await db.query(`UPDATE "OrderIntent" SET status='pending' WHERE id=$1`, [g.intentId]);
    const a = await assignmentOf(g.intentId);
    const acct = (await db.query(`SELECT "tradingAccountId" FROM "TradingAccountSubscription" WHERE id=$1`, [a])).rows[0].tradingAccountId as number;
    return { g, assignmentId: a, accountId: acct };
  };
  const claimSql = `INSERT INTO "ExternalSignalBrokerWorkerClaim" ("orderIntentId","executionObligationId","accountCycleId","rolloutGenerationId","dispatchStateVersion","clientOrderId","claimFingerprint")
    SELECT o."orderIntentId", o.id, o."accountCycleId", o."rolloutGenerationId", $2, o."clientOrderId", $3 FROM "ExternalSignalEntryExecutionObligation" o WHERE o."orderIntentId"=$1 RETURNING id`;
  const insertClaim = async (c: any, g: any) => attempt(c, claimSql, [g.intentId, await dispatchStateVersion(), '0'.repeat(64)]);

  // ---- C1: implicit lock sets, measured on the real objects.
  {
    const { g } = await prepare();
    const t = await mk(url);
    await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
    const r = await insertClaim(t, g);
    const current = flat(await trace(t));
    await t.query('ROLLBACK'); await t.end();
    results.lockSets = { ...(results.lockSets as object ?? {}), 'TV worker-claim insert, CURRENT guard': current };
    check(S, 'C1a the current claim guard locks TradingAccount and TradingAccountSubscription FOR UPDATE (and Subscription, Security)', r.ok && ['TradingAccount', 'TradingAccountSubscription', 'Subscription', 'Security'].every(table => current.some(x => x.startsWith(`${table}#`) && /Update/.test(x) && !/NoKey|KeyShare/.test(x))), current);
  }

  // Planner-order evidence for the current guard: block it on one identity row, see whether it already holds the other.
  for (const [blocked, other] of [['TradingAccountSubscription', 'TradingAccount'], ['TradingAccount', 'TradingAccountSubscription']] as const) {
    const { g, assignmentId, accountId } = await prepare();
    const x = await mk(url), t = await mk(url);
    try {
      await x.query('BEGIN'); await x.query(`SELECT id FROM "${blocked}" WHERE id=$1 FOR UPDATE`, [blocked === 'TradingAccount' ? accountId : assignmentId]);
      await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
      let done = false; const pending = insertClaim(t, g).then((r: any) => { done = true; return r; });
      const isBlocked = await untilBlocked(pidOf(t), () => done);
      const held = (await db.query(`SELECT count(*)::int n FROM pgrowlocks('"${other}"') WHERE $1 = ANY(pids)`, [pidOf(t)])).rows[0].n as number;
      ((results.lockOrderEvidence ??= {}) as any)[`current guard blocked on ${blocked}`] = { isBlocked, alreadyHolds: `${other}: ${held > 0}` };
      await x.query('COMMIT'); await pending;
    } finally { await finish(x, t); }
  }

  // ---- C2: the deadlock. Real MI grant (TAS FOR UPDATE, then the grant trigger's TradingAccount FOR SHARE) against TradingView.
  type Variant = { name: string; start: (t: any, ctx: { accountId: number; assignmentId: number; g: any }) => Promise<void>; claim: boolean };
  const lockSql = (table: string, id: number, mode: string) => `SELECT id FROM "${table}" WHERE id=${id} FOR ${mode}`;
  async function race(variant: Variant, firstInQueue: 'MI' | 'TV') {
    const { g, assignmentId, accountId } = await prepare();
    const generation = await mi.enroll(assignmentId);
    const x = await mk(url), t = await mk(url);
    const outcome: Record<string, unknown> = { variant: variant.name, firstInQueue };
    try {
      await x.query('BEGIN'); await x.query(lockSql('TradingAccountSubscription', assignmentId, 'UPDATE'));
      await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
      let grant: Promise<any> | undefined; let tvDone: Promise<any> | undefined; let tvSettled = false;
      const startGrant = async () => { grant = mi.grant(assignmentId, generation).then((v: any) => ({ ok: true, v }), (e: any) => ({ ok: false, message: String(e.message).slice(0, 100), code: e.details?.code ?? e.code })); await untilMiBlocked(); };
      const startTv = async () => {
        tvDone = (async () => {
          const steps = [lockSql('TradingAccount', accountId, variant.name.startsWith('rev3') ? 'UPDATE' : 'SHARE'), lockSql('TradingAccountSubscription', assignmentId, variant.name.startsWith('rev3') ? 'UPDATE' : 'SHARE')];
          for (const sql of steps) { const r = await attempt(t, sql); if (!r.ok) return r; }
          const r: any = variant.claim ? await insertClaim(t, g) : { ok: true };
          if (r.ok) await t.query('COMMIT');
          return r;
        })().then(r => { tvSettled = true; return r; });
        await untilBlocked(pidOf(t), () => tvSettled);
      };
      if (firstInQueue === 'MI') { await startGrant(); await startTv(); } else { await startTv(); await startGrant(); }
      await x.query('COMMIT');
      const started = Date.now();
      const [grantResult, tvResult] = await Promise.all([grant, tvDone]);
      outcome.elapsedMs = Date.now() - started;
      outcome.mi = grantResult.ok ? 'GRANTED' : `${grantResult.code ?? ''} ${grantResult.message}`;
      outcome.tv = (tvResult as any).ok ? 'STEPS_OK' : `${(tvResult as any).code} ${(tvResult as any).message}`;
      outcome.deadlock = /40P01/.test(String((tvResult as any).code)) || /CONCURRENT_AUTHORIZATION_CHANGE|deadlock/i.test(String(grantResult.message ?? '') + String(grantResult.code ?? ''));
    } finally { await finish(x, t); }
    return outcome;
  }

  const raceResults: any[] = [];
  const rev3 = await race({ name: 'rev3 pre-locks (TradingAccount FOR UPDATE, then assignment FOR UPDATE)', start: async () => undefined, claim: false }, 'MI');
  raceResults.push(rev3);
  check(S, 'C2.1 reproduction: revision-3 order (TradingAccount FOR UPDATE before the assignment) deadlocks with the real MI grant (40P01 / CONCURRENT_AUTHORIZATION_CHANGE)', rev3.deadlock === true, rev3);

  // Current guard (planner-ordered multi-table FOR UPDATE) against the real grant: recorded, not asserted (plan dependent).
  const currentGuardRace = await race({ name: 'current guard (planner order)', start: async () => undefined, claim: true }, 'MI');
  // The current guard is reached only after our explicit SHARE steps in this harness; the unmodified-guard deadlock is therefore
  // measured separately below with no pre-locks at all.
  void currentGuardRace;
  {
    const { g, assignmentId } = await prepare();
    const generation = await mi.enroll(assignmentId);
    const x = await mk(url), t = await mk(url);
    const observed: Record<string, unknown> = { name: 'CURRENT guard alone, no pre-locks, MI queued first' };
    try {
      await x.query('BEGIN'); await x.query(lockSql('TradingAccountSubscription', assignmentId, 'UPDATE'));
      const grant = mi.grant(assignmentId, generation).then((v: any) => ({ ok: true, v }), (e: any) => ({ ok: false, message: String(e.message).slice(0, 100) }));
      await untilMiBlocked();
      await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
      let done = false; const tv = insertClaim(t, g).then((r: any) => { done = true; return r; });
      await untilBlocked(pidOf(t), () => done);
      await x.query('COMMIT');
      const [gr, tr] = await Promise.all([grant, tv]);
      observed.mi = (gr as any).ok ? 'GRANTED' : (gr as any).message; observed.tv = (tr as any).ok ? 'CLAIM_INSERTED' : `${(tr as any).code} ${(tr as any).message}`;
      observed.deadlock = !(gr as any).ok || !(tr as any).ok;
    } finally { await finish(x, t); }
    raceResults.push(observed);
    (results.lockOrderEvidence as any)['current guard vs real MI grant'] = observed;
  }

  // ---- C3: the correction. Replace the claim guard's identity locks with FOR SHARE in the probe database only, then repeat.
  const original = (await db.query(`SELECT pg_get_functiondef('external_signal_broker_worker_claim_guard'::regproc) AS def`)).rows[0].def as string;
  const target = 'FOR UPDATE OF i,ac,c,auth,gen,ta,tas,sub,sec,src,b,rev,ec';
  const replacement = 'FOR UPDATE OF i,ac,c,auth,gen,src,b,rev,ec FOR SHARE OF ta,tas,sub,sec';
  check(S, 'C3.0 the corrected guard is the real guard text with only the identity lock mode changed', original.includes(target));
  await db.query(original.replace(target, replacement));
  const fixes: any[] = [];
  for (const first of ['MI', 'TV'] as const) {
    const o = await race({ name: 'rev4 pre-locks (TradingAccount FOR SHARE, assignment FOR SHARE) then corrected guard', start: async () => undefined, claim: true }, first);
    fixes.push(o);
    check(S, `C3.${first} corrected order (${first} first in the queue): no deadlock; the MI grant is granted and the claim insert succeeds`, o.deadlock === false && o.mi === 'GRANTED' && o.tv === 'STEPS_OK', o);
  }
  results.lockRaces = { reproduction: raceResults, corrected: fixes };

  // The corrected guard still sets the same implicit lock set, now with SHARE on the four identity relations.
  {
    const { g, assignmentId, accountId } = await prepare();
    const t = await mk(url);
    await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
    for (const sql of [lockSql('TradingAccount', accountId, 'SHARE'), lockSql('TradingAccountSubscription', assignmentId, 'SHARE')]) await t.query(sql);
    const r = await insertClaim(t, g);
    const corrected = flat(await trace(t));
    await t.query('ROLLBACK'); await t.end();
    (results.lockSets as any)['TV worker-claim insert, CORRECTED guard (after TradingAccount and assignment FOR SHARE pre-locks)'] = corrected;
    const upgrades = corrected.filter(x => /^(TradingAccount|TradingAccountSubscription|Subscription|Security)#/.test(x) && /(^|\+)Update$|NoKeyUpdate/.test(x));
    check(S, 'C3.1 no hidden lock upgrade: after the corrected guard the four identity relations are held SHARE (never UPDATE)', r.ok && upgrades.length === 0, { upgrades, corrected });
  }

  // ---- C4: the full pair (F) lock set including FK KEY SHARE locks and the consumption guards' own locks.
  {
    const g = await claimed(); const d = await decided(g);
    const f = await mk(url);
    try {
      await f.query(`BEGIN ISOLATION LEVEL ${SER}`);
      await f.query('SELECT id FROM "OrderIntent" WHERE id=$1 FOR UPDATE', [g.intentId]); await f.query('SELECT id FROM "EntryExposureClaim" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId]);
      const v = (await f.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1 FOR UPDATE', [g.intentId])).rows[0].v;
      const before = flat(await trace(f));
      const m = await miInsert(f, g, d.decisionId); await tvInsert(f, g, m, v);
      const after = flat(await trace(f));
      (results.lockSets as any)['pair F: locks added by the MI + TV consumption inserts (beyond intent, claim, fence)'] = after.filter(x => !before.includes(x));
      await f.query('ROLLBACK');
      check(S, 'C4 pair lock set recorded', true);
    } finally { await finish(f); }
  }

  // ---- C5: MI revoke (real service) against the corrected TradingView sequence that ends in the MI authorization FOR SHARE.
  {
    const { g, assignmentId, accountId } = await prepare();
    const generation = await mi.enroll(assignmentId); const grant = await mi.grant(assignmentId, generation) as any;
    const x = await mk(url), t = await mk(url);
    try {
      await x.query('BEGIN'); await x.query(lockSql('TradingAccountSubscription', assignmentId, 'UPDATE'));
      const revoke = mi.revoke(assignmentId, grant.id).then((v: any) => ({ ok: true, v }), (e: any) => ({ ok: false, message: String(e.message).slice(0, 100) }));
      await untilMiBlocked();
      await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
      let done = false; const tv = (async () => {
        for (const sql of [lockSql('TradingAccount', accountId, 'SHARE'), lockSql('TradingAccountSubscription', assignmentId, 'SHARE'), `SELECT id FROM "AssignmentMarketPolicyEnforcementAuthorization" WHERE "accountSubscriptionId"=${assignmentId} ORDER BY id DESC LIMIT 1 FOR SHARE`]) { const r = await attempt(t, sql); if (!r.ok) return r; }
        const r: any = await insertClaim(t, g); if (r.ok) await t.query('COMMIT'); return r;
      })().then((r: any) => { done = true; return r; });
      await untilBlocked(pidOf(t), () => done);
      await x.query('COMMIT');
      const [rr, tr] = await Promise.all([revoke, tv]);
      check(S, 'C5 MI revoke (real service) against the corrected TradingView sequence (TradingAccount, assignment, then MI authorization FOR SHARE): no deadlock; the revoke is never lost (TradingView proceeds or gets 40001 and must retry)', (rr as any).ok && ((tr as any).ok || (tr as any).code === '40001'), { revoke: (rr as any).ok ? 'REVOKED' : (rr as any).message, tv: (tr as any).ok ? 'ok' : `${(tr as any).code} ${(tr as any).message}` });
    } finally { await finish(x, t); }
  }

  // ---- C5b/C7: TradingAccountAllocation is a leaf: its writers take no other lock and it has no trigger, so SHARE as the last
  //              identity lock cannot close a cycle; a disable waits for TradingView or is seen as a newer version (40001).
  {
    const { assignmentId, accountId } = await prepare();
    const allocationId = (await db.query(`SELECT "allocationId" FROM "TradingAccountSubscription" WHERE id=$1`, [assignmentId])).rows[0].allocationId as number;
    const t = await mk(url), a = await mk(url);
    try {
      await t.query(`BEGIN ISOLATION LEVEL ${SER}`);
      for (const sql of [lockSql('TradingAccount', accountId, 'SHARE'), lockSql('TradingAccountSubscription', assignmentId, 'SHARE'), lockSql('TradingAccountAllocation', allocationId, 'SHARE')]) await t.query(sql);
      let done = false; const upd = attempt(a, `UPDATE "TradingAccountAllocation" SET enabled=false WHERE id=${allocationId}`).then((r: any) => { done = true; return r; });
      const waits = await untilBlocked(pidOf(a), () => done);
      await t.query('COMMIT'); const ur = await upd;
      // stale TradingView after the committed disable
      const t2 = await mk(url); await t2.query(`BEGIN ISOLATION LEVEL ${SER}`); await t2.query('SELECT 1');
      await db.query(`UPDATE "TradingAccountAllocation" SET enabled=true WHERE id=${allocationId}`);
      const stale = await attempt(t2, lockSql('TradingAccountAllocation', allocationId, 'SHARE')); await finish(t2);
      check(S, 'C7 allocation disable waits for a TradingView FOR SHARE hold and is a 40001 for a stale TradingView snapshot', waits && ur.ok && stale.code === '40001', { waits, update: ur.ok, stale: stale.code ?? 'ok' });
    } finally { await finish(t, a); }
  }

  // ---- C8: pre-existing inversions found by the catalog extraction (accepted C1 code, not new C3B.2 code).
  //   (a) TradingView authorization GRANT (service: TradingAccount FOR UPDATE, then assignment FOR UPDATE) against the real MI grant
  //       (assignment FOR UPDATE, then the grant trigger's TradingAccount FOR SHARE). Different owners isolate this cycle.
  //   (b) The TradingView authorization guard locks User FOR UPDATE (FOR UPDATE OF tas,ta,s,src,b,r,u) AFTER the assignment, while
  //       every MI owner operation locks User FOR SHARE FIRST. Same owner: MI holds User, wants the assignment; TV holds the
  //       assignment, wants User.
  const countBlocked = async () => (await db.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='r4-prisma' AND state='active' AND wait_event_type='Lock'`)).rows[0].n as number;
  const untilBlockedCount = async (n: number) => { for (let i = 0; i < 800; i += 1) { if ((await countBlocked()) >= n) return true; await sleep(10); } return false; };
  const authority = await import('../../src/services/external-signal-execution-authority.service.js');
  const owner2 = (await db.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('r4-owner2@test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id as number;
  let targetSeq = 0;
  async function makeTarget() {
    targetSeq += 1; const n = targetSeq; const symbol = `R4T${Date.now() % 1e7}${n}`;
    const strategyId = (await db.query(`SELECT id FROM "Strategy" WHERE key='tv-graph'`)).rows[0].id as number;
    const exitId = (await db.query(`SELECT id FROM "ExitProfile" WHERE key='tv-graph'`)).rows[0].id as number;
    const securityId = (await db.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ($1,$1,true,'STOCK',now(),now()) RETURNING id`, [symbol])).rows[0].id as number;
    const subscriptionId = (await db.query(`INSERT INTO "Subscription" (key,name,symbol,enabled,"strategyId","exitProfileId","securityId","createdAt","updatedAt") VALUES ($1,$1,$2,true,$3,$4,$5,now(),now()) RETURNING id`, [`r4t-${symbol}`, symbol, strategyId, exitId, securityId])).rows[0].id as number;
    const assignmentId = (await db.query(`INSERT INTO "TradingAccountSubscription" ("tradingAccountId","subscriptionId",enabled,"entriesEnabled","exitsEnabled","sizingType","fixedQty","createdAt","updatedAt") VALUES ($1,$2,true,true,true,'FIXED_QTY',1,now(),now()) RETURNING id`, [paperId, subscriptionId])).rows[0].id as number;
    const allocationId = (await db.query(`INSERT INTO "TradingAccountAllocation" ("tradingAccountId",key,name,enabled,"maxAllocatedNotional","maxPositionNotional","createdAt","updatedAt") VALUES ($1,$2,$2,true,10000,1000,now(),now()) RETURNING id`, [paperId, `r4a-${symbol}`])).rows[0].id as number;
    await db.query(`UPDATE "TradingAccountSubscription" SET "allocationId"=$2 WHERE id=$1`, [assignmentId, allocationId]);
    const bindingId = (await db.query(`SELECT id FROM "StrategySignalBinding" ORDER BY id LIMIT 1`)).rows[0].id as number;
    const revisionId = (await db.query(`SELECT id FROM "StrategySignalRevision" WHERE "strategySignalBindingId"=$1 AND status='ACTIVE' LIMIT 1`, [bindingId])).rows[0].id as number;
    const generationId = (await db.query(`SELECT id FROM "ExternalSignalExecutionRolloutGeneration" WHERE direction='ENTRY' AND "authorityMode"='EXECUTE' AND enabled ORDER BY id DESC LIMIT 1`)).rows[0].id as number;
    return { assignmentId, securityId, bindingId, revisionId, generationId };
  }
  {
    const t = await makeTarget(); const generation = await mi.enroll(t.assignmentId);
    const x = await mk(url);
    const settle = (promise: Promise<any>) => promise.then((v: any) => ({ ok: true, v }), (e: any) => ({ ok: false, message: String(e.message).slice(0, 120), code: e.details?.code ?? e.code }));
    try {
      await x.query('BEGIN'); await x.query(lockSql('TradingAccountSubscription', t.assignmentId, 'UPDATE'));
      const miGrant = settle(mi.grant(t.assignmentId, generation));
      const first = await untilBlockedCount(1);
      const tvGrant = settle(authority.grantExternalSignalEntryExecutionAuthorization(paperId, t.assignmentId, { rolloutGenerationId: t.generationId, strategySignalBindingId: t.bindingId, expectedStrategySignalRevisionId: t.revisionId, expectedSecurityId: t.securityId, reason: 'R4 probe' }, owner2));
      const second = await untilBlockedCount(2);
      await x.query('COMMIT');
      const [a, b] = await Promise.all([miGrant, tvGrant]);
      const text = (r: any) => (r.ok ? 'OK' : `${r.code ?? ''} ${r.message}`);
      const victim = [a, b].some((r: any) => !r.ok && /deadlock|CONCURRENT_AUTHORIZATION_CHANGE|CONCURRENT_AUTHORITY_CHANGE|40P01|could not serialize/i.test(`${r.code} ${r.message}`));
      ((results.lockOrderEvidence ??= {}) as any)['TV authorization grant (real service) vs MI grant (real service), different owners'] = { bothWaiting: first && second, mi: text(a), tv: text(b), deadlockVictim: victim };
      check(S, 'C8a EXISTING INVERSION: the TradingView authorization grant (TradingAccount FOR UPDATE before the assignment) deadlocks with the MI grant (assignment before TradingAccount FOR SHARE)', first && second && victim, { mi: text(a), tv: text(b) });
    } finally { await finish(x); }
  }
  {
    // (b) replay, same owner. The TV side replays the guard's statements in the order the real guard takes them.
    const raceUser = async (steps: (ids: { userId: number; accountId: number; assignmentId: number }) => string[]) => {
      const { assignmentId, accountId } = await prepare(); const generation = await mi.enroll(assignmentId);
      const userId = ownerId; const x = await mk(url), tv = await mk(url);
      try {
        await x.query('BEGIN'); await x.query(lockSql('TradingAccountSubscription', assignmentId, 'UPDATE'));
        await tv.query(`BEGIN ISOLATION LEVEL ${SER}`);
        let done = false;
        const tvRun = (async () => { for (const sql of steps({ userId, accountId, assignmentId })) { const r = await attempt(tv, sql); if (!r.ok) return r; } await tv.query('COMMIT'); return { ok: true } as any; })().then((r: any) => { done = true; return r; });
        await untilBlocked(pidOf(tv), () => done);
        const grant = mi.grant(assignmentId, generation).then((v: any) => ({ ok: true, v }), (e: any) => ({ ok: false, message: String(e.message).slice(0, 120), code: e.details?.code ?? e.code }));
        await untilBlockedCount(1);
        await x.query('COMMIT');
        const [g, r] = await Promise.all([grant, tvRun]);
        return { mi: (g as any).ok ? 'GRANTED' : `${(g as any).code} ${(g as any).message}`, tv: (r as any).ok ? 'ok' : `${(r as any).code} ${(r as any).message}`, deadlock: !(g as any).ok || !(r as any).ok };
      } finally { await finish(x, tv); }
    };
    const late = await raceUser(({ userId, accountId, assignmentId }) => [lockSql('TradingAccount', accountId, 'SHARE'), lockSql('TradingAccountSubscription', assignmentId, 'SHARE'), lockSql('User', userId, 'UPDATE')]);
    const first = await raceUser(({ userId, accountId, assignmentId }) => [lockSql('User', userId, 'SHARE'), lockSql('TradingAccount', accountId, 'SHARE'), lockSql('TradingAccountSubscription', assignmentId, 'SHARE')]);
    ((results.lockOrderEvidence ??= {}) as any)['User lock position'] = { 'guard order (assignment, then User FOR UPDATE)': late, 'corrected (User FOR SHARE first)': first };
    check(S, 'C8b EXISTING INVERSION: the guard late User FOR UPDATE deadlocks with MI User-first order; taking User FOR SHARE first removes it', late.deadlock === true && first.deadlock === false && first.mi === 'GRANTED', { late, first });
  }

  // ---- C9: the implicit parent-cycle lock. ExternalSignalTradeCycleAccount BEFORE INSERT/UPDATE locks the parent TradeCycle
  //           FOR UPDATE after the account-cycle row itself, i.e. in the opposite order to EXIT correlation (cycle, then account).
  {
    const { g } = await prepare();
    const row = (await db.query(`SELECT ac.id AS ac, ac."externalSignalTradeCycleId" AS cycle FROM "ExternalSignalTradeCycleAccount" ac WHERE ac.id=$1`, [g.accountCycleId])).rows[0];
    const exit = await mk(url), writer = await mk(url);
    try {
      await exit.query('BEGIN'); await exit.query(lockSql('ExternalSignalTradeCycle', row.cycle, 'UPDATE'));
      await writer.query('BEGIN');
      let done = false; const upd = attempt(writer, `UPDATE "ExternalSignalTradeCycleAccount" SET "updatedAt"=now() WHERE id=${row.ac}`).then((r: any) => { done = true; return r; });
      const waitsOnCycle = await untilBlocked(pidOf(writer), () => done);
      const holdsAccount = (await db.query(`SELECT count(*)::int n FROM pgrowlocks('"ExternalSignalTradeCycleAccount"') WHERE $1 = ANY(pids)`, [pidOf(writer)])).rows[0].n > 0;
      const second = await attempt(exit, lockSql('ExternalSignalTradeCycleAccount', row.ac, 'UPDATE'));
      const u = await upd;
      check(S, 'C9 an account-cycle UPDATE holds the account-cycle row and then waits for the parent cycle (trigger); against the EXIT-correlation order (cycle, then account) it deadlocks unless the writer locks the cycle first', waitsOnCycle && holdsAccount && (second.code === '40P01' || u.code === '40P01'), { waitsOnCycle, holdsAccount, exitSecondLock: second.code ?? 'ok', writer: u.code ?? 'ok' });
    } finally { await finish(exit, writer); }
  }

  // ---- C6: pause / kill switch serialization with TradingAccount held FOR SHARE (run last: the committed pause invalidates authorizations).
  {
    const { accountId } = await prepare();
    // (a) TV holds the share lock: the pause UPDATE waits for it.
    const t = await mk(url), p = await mk(url);
    try {
      await t.query(`BEGIN ISOLATION LEVEL ${SER}`); await t.query(lockSql('TradingAccount', accountId, 'SHARE'));
      let done = false; const pending = attempt(p, `UPDATE "TradingAccount" SET "tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=${accountId}`).then((r: any) => { done = true; return r; });
      const waits = await untilBlocked(pidOf(p), () => done);
      await t.query('ROLLBACK');
      const pr = await pending; await p.query(`UPDATE "TradingAccount" SET "tradingEnabled"=true,"killSwitchEnabled"=false WHERE id=${accountId}`);
      check(S, 'C6a a kill-switch UPDATE waits for a TradingView FOR SHARE hold on the account', waits && pr.ok, { waits, update: pr.ok ? 'applied after release' : pr.message });
    } finally { await finish(t, p); }
    // (b) pause committed after TV's snapshot: SERIALIZABLE TV gets 40001 on the share lock.
    const t2 = await mk(url);
    try {
      await t2.query(`BEGIN ISOLATION LEVEL ${SER}`); await t2.query('SELECT 1');
      await db.query(`UPDATE "TradingAccount" SET status='PAUSED',"tradingEnabled"=false,"killSwitchEnabled"=true WHERE id=${accountId}`);
      const lock = await attempt(t2, lockSql('TradingAccount', accountId, 'SHARE'));
      check(S, 'C6b a pause committed after the TradingView snapshot is a 40001 on the FOR SHARE read, never a stale pass', lock.code === '40001', lock.code ?? 'ok');
    } finally { await finish(t2); }
    // (c) a fresh transaction sees the pause.
    const t3 = await mk(url);
    try {
      await t3.query(`BEGIN ISOLATION LEVEL ${SER}`);
      const seen = (await t3.query(`SELECT status::text FROM "TradingAccount" WHERE id=${accountId} FOR SHARE`)).rows[0].status;
      check(S, 'C6c a transaction started after the pause reads PAUSED under FOR SHARE', seen === 'PAUSED', seen);
    } finally { await finish(t3); await db.query(`UPDATE "TradingAccount" SET status='ACTIVE',"tradingEnabled"=true,"killSwitchEnabled"=false WHERE id=${accountId}`); }
  }
  void fenceOf; void claimed;
}

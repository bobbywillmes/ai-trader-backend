// Section I of the revision-5 real-schema probes: fence INSERT integrity, trigger execution order, and the security manifest.
//  I1  the fence INSERT guard: direct SQL and a restricted runtime-like role cannot create, seed or alter fences.
//  I2  the not-sent protection depends on the claim delivery fence trigger running BEFORE the not-sent guard (alphabetical trigger order):
//      the catalog regression, the hazard when the order flips, and a trigger-independent alternative.
//  I3  the C3B.1 security readiness manifest still detects renamed, missing, disabled, rebound and altered objects after the overlay.
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function run(ctx: any) {
  const { db, url, mk, attempt, pidOf, untilBlocked, check, results, claimed, admitted, readiness, sqlRows, catalogBefore, paperId } = ctx;
  const S = 'integrity';
  const finish = async (...cs: any[]) => { for (const c of cs) { await c.query('ROLLBACK').catch(() => undefined); await c.end().catch(() => undefined); } };
  const unmarkedIntent = async () => (await db.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt") VALUES ('legacy','SEED','buy','market','day','received',$1,'{}',$2,now(),now()) RETURNING id`, [`r5i-${Math.random()}`, paperId])).rows[0].id as number;
  const totals = async () => (await db.query('SELECT count(*)::int n, coalesce(sum(version),0)::int s FROM "ExternalSignalDispatchFence"')).rows[0];

  // ---- I1: fence INSERT integrity.
  {
    const unmarked = await unmarkedIntent();
    const marked = await claimed();
    const before = await totals();
    const asOwner = {
      unmarked: await attempt(db, 'INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 1)', [unmarked]),
      v999OnMarkedDuplicate: await attempt(db, 'INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 999)', [marked.intentId]),
      update: await attempt(db, 'UPDATE "ExternalSignalDispatchFence" SET version = 999 WHERE "orderIntentId" = $1', [marked.intentId]),
      del: await attempt(db, 'DELETE FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = $1', [marked.intentId]),
      truncate: await attempt(db, 'TRUNCATE "ExternalSignalDispatchFence"'),
    };
    check(S, 'I1a [owner/superuser direct SQL] a fence for an unmarked intent, a version-999 insert, a direct UPDATE, DELETE and TRUNCATE are all rejected', Object.values(asOwner).every(o => !o.ok) && /created only by the marked-intent creation trigger/.test(asOwner.unmarked.message ?? ''),
      Object.fromEntries(Object.entries(asOwner).map(([k, v]) => [k, v.message])));
    check(S, 'I1a2 none of those statements changed the fence table (row count and version sum identical)', JSON.stringify(await totals()) === JSON.stringify(before), { before, after: await totals() });

    // Restricted role with ordinary DML privileges on every table (the guard, not privileges, is the barrier for the runtime role).
    await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='r5_app') THEN CREATE ROLE r5_app NOLOGIN NOSUPERUSER NOBYPASSRLS; END IF; END $$`);
    await db.query('GRANT USAGE ON SCHEMA public TO r5_app'); await db.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO r5_app'); await db.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO r5_app');
    const asRole = async (sql: string, params: unknown[] = []) => { await db.query('SET ROLE r5_app'); try { return await attempt(db, sql, params); } finally { await db.query('RESET ROLE'); } };
    // A marked intent WITHOUT a fence (a missed backfill, or corruption by an owner): the fence row is deleted with the guard disabled.
    // With the creation trigger disabled, admission itself fails closed at its first fenced write (the claim insert), see I1c.
    await db.query('ALTER TABLE "OrderIntent" DISABLE TRIGGER "OrderIntent_dispatch_fence_create"');
    const creationDisabled = await admitted().then(() => 'ADMITTED', (e: any) => String(e.message).slice(0, 100));
    await db.query('ROLLBACK').catch(() => undefined); // the fixture leaves its transaction open when admission fails
    await db.query('ALTER TABLE "OrderIntent" ENABLE TRIGGER "OrderIntent_dispatch_fence_create"');
    const orphan = await admitted();
    await db.query('ALTER TABLE "ExternalSignalDispatchFence" DISABLE TRIGGER "ExternalSignalDispatchFence_guard"');
    await db.query('DELETE FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [orphan.intentId]);
    await db.query('ALTER TABLE "ExternalSignalDispatchFence" ENABLE TRIGGER "ExternalSignalDispatchFence_guard"');
    const role = {
      unmarked: await asRole('INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 1)', [unmarked]),
      v999: await asRole('INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 999)', [orphan.intentId]),
      v1Direct: await asRole('INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 1)', [orphan.intentId]),
      update: await asRole('UPDATE "ExternalSignalDispatchFence" SET version = version + 1 WHERE "orderIntentId" = $1', [marked.intentId]),
      del: await asRole('DELETE FROM "ExternalSignalDispatchFence" WHERE "orderIntentId" = $1', [marked.intentId]),
      setReplicationRole: await asRole(`SET session_replication_role = 'replica'`),
    };
    const missing = (await db.query(`SELECT count(*)::int n FROM "OrderIntent" i WHERE i."externalSignalAccountCycleId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ExternalSignalDispatchFence" f WHERE f."orderIntentId"=i.id)`)).rows[0].n;
    // the intent admitted while the creation trigger was disabled also lacks a fence (its admission failed after the intent insert rolled back, so it may not exist at all)
    const bumpOnOrphan = await attempt(db, `UPDATE "OrderIntent" SET "updatedAt"=now() WHERE id=$1`, [orphan.intentId]);
    check(S, 'I1b [restricted role with plain DML grants] unmarked, version-999 and direct version-1 inserts, UPDATE, DELETE and SET session_replication_role are all rejected', Object.values(role).every(o => !o.ok) && /version 1 \(supplied 999\)|created only by/.test(role.v999.message ?? ''), Object.fromEntries(Object.entries(role).map(([k, v]) => [k, v.message])));
    check(S, 'I1c a marked intent without a fence is DETECTABLE by the preflight invariant query and every later fenced write on it fails closed; with the creation trigger disabled even admission fails closed at its first fenced write', missing === 1 && !bumpOnOrphan.ok && /has no dispatch fence/.test(bumpOnOrphan.message ?? '') && /has no dispatch fence/.test(creationDisabled), { markedIntentsWithoutFence: missing, fencedWrite: bumpOnOrphan.message, admissionWithCreationTriggerDisabled: creationDisabled });
    // heal the disposable orphan the only legitimate way (a migration-time insert with the guard absent) so later sections are unaffected
    await db.query('ALTER TABLE "ExternalSignalDispatchFence" DISABLE TRIGGER "ExternalSignalDispatchFence_guard"');
    await db.query('INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) VALUES ($1, 1)', [orphan.intentId]);
    await db.query('ALTER TABLE "ExternalSignalDispatchFence" ENABLE TRIGGER "ExternalSignalDispatchFence_guard"');
    // the legitimate creation path under the restricted role: a marked intent inserted by r5_app gets its fence from the trigger
    await db.query('SET ROLE r5_app');
    let viaRole: any; try { viaRole = await admitted(); } catch (e: any) { viaRole = { error: String(e.message).slice(0, 120) }; } finally { await db.query('RESET ROLE'); }
    check(S, 'I1d the legitimate path still works under the restricted role: a marked intent inserted by it receives its fence from the creation trigger (created at 1; the admission claim insert advanced it)', viaRole.intentId !== undefined && (await db.query('SELECT version::int v FROM "ExternalSignalDispatchFence" WHERE "orderIntentId"=$1', [viaRole.intentId])).rows[0]?.v >= 2, viaRole.error ?? { intentId: viaRole.intentId });
    const promote = await attempt(db, `UPDATE "OrderIntent" SET "externalSignalAccountCycleId"=$2 WHERE id=$1`, [unmarked, marked.accountCycleId]);
    check(S, 'I1e an unmarked intent cannot be promoted to marked by UPDATE (so the creation trigger needs no UPDATE branch)', !promote.ok && /insert-only and immutable/.test(promote.message ?? ''), promote.message);
  }

  // ---- I2: trigger execution order for the not-sent protection.
  const triggerOrder = async () => (await db.query(`SELECT t.tgname::text AS name, p.proname::text AS fn, t.tgenabled::text AS enabled FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgrelid='"EntryExposureClaimEvent"'::regclass AND NOT t.tgisinternal AND (t.tgtype & 2) <> 0 AND (t.tgtype & 4) <> 0 AND (t.tgtype & 1) <> 0 ORDER BY t.tgname COLLATE "C"`)).rows as Array<{ name: string; fn: string; enabled: string }>;
  const FIRST = 'EntryExposureClaimEvent_external_signal_c2_delivery_fence', SECOND = 'EntryExposureClaimEvent_external_signal_c2_not_sent_guard';
  const orderOk = (rows: Array<{ name: string; fn: string; enabled: string }>) => {
    const i = rows.findIndex(r => r.name === FIRST), j = rows.findIndex(r => r.name === SECOND);
    return i >= 0 && j >= 0 && i < j && rows[i]!.fn === 'external_signal_c2_delivery_event_fence' && rows[j]!.fn === 'external_signal_c2_not_sent_evidence_guard' && ['O', 'A'].includes(rows[i]!.enabled) && ['O', 'A'].includes(rows[j]!.enabled);
  };
  const baselineOrder = await triggerOrder();
  check(S, 'I2a catalog regression: on EntryExposureClaimEvent (BEFORE INSERT, ROW) the claim delivery fence fires before the not-sent guard (name order, "C" collation), both enabled and bound to the expected functions', orderOk(baselineOrder), baselineOrder);

  const notSent = (g: any) => `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT c.id,'NOT_SENT_EVIDENCE_RECORDED',jsonb_build_object('classification','NOT_SENT_PRE_DISPATCH','producer','TRADINGVIEW_C2_PRE_DISPATCH_RECOVERY','workerClaimId',${g.workerClaimId}) FROM "EntryExposureClaim" c WHERE c."orderIntentId"=${g.intentId}`;
  const adapter = (g: any) => `INSERT INTO "EntryExposureClaimEvent" ("claimId","eventType","evidenceJson") SELECT id,'ADAPTER_INVOCATION_STARTED','{}' FROM "EntryExposureClaim" WHERE "orderIntentId"=${g.intentId}`;
  async function raceNotSentAgainstAdapter() {
    const g = await claimed();
    const adapterTx = await mk(url), notSentTx = await mk(url);
    try {
      await adapterTx.query('BEGIN'); const a = await attempt(adapterTx, adapter(g));
      await notSentTx.query('BEGIN');
      let done = false; const pending = attempt(notSentTx, notSent(g)).then((r: any) => { done = true; return r; });
      const blocked = await untilBlocked(pidOf(notSentTx), () => done);
      await adapterTx.query('COMMIT');
      const n = await pending; if (n.ok) await notSentTx.query('COMMIT');
      const events = (await db.query(`SELECT array_agg(e."eventType" ORDER BY e.id) AS t FROM "EntryExposureClaimEvent" e JOIN "EntryExposureClaim" c ON c.id=e."claimId" WHERE c."orderIntentId"=$1`, [g.intentId])).rows[0].t as string[];
      return { adapterInserted: a.ok, blocked, notSent: n.ok ? 'RECORDED' : n.message, bothRecorded: events.includes('NOT_SENT_EVIDENCE_RECORDED') && events.includes('ADAPTER_INVOCATION_STARTED') };
    } finally { await finish(adapterTx, notSentTx); }
  }
  const proper = await raceNotSentAgainstAdapter();
  check(S, 'I2b with the shipped order, a not-sent insert queued behind an uncommitted ADAPTER_INVOCATION_STARTED waits at the claim lock, then is REFUSED as contradictory', proper.adapterInserted && proper.blocked && proper.notSent !== 'RECORDED' && /contradicts persisted dispatch/.test(String(proper.notSent)) && !proper.bothRecorded, proper);

  await db.query(`ALTER TRIGGER "${FIRST}" ON "EntryExposureClaimEvent" RENAME TO "EntryExposureClaimEvent_zz_external_signal_c2_delivery_fence"`);
  let flipped: any, orderAfterFlip: any, alternative: any;
  try {
    orderAfterFlip = await triggerOrder();
    flipped = await raceNotSentAgainstAdapter();
    // trigger-independent alternative: the not-sent guard takes the claim lock itself, as its first statement for a NOT_SENT event.
    const original = (await db.query(`SELECT pg_get_functiondef('external_signal_c2_not_sent_evidence_guard()'::regprocedure) AS def`)).rows[0].def as string;
    const needle = `IF NEW."eventType"<>'NOT_SENT_EVIDENCE_RECORDED' THEN RETURN NEW; END IF;`;
    if (!original.includes(needle)) throw new Error('not-sent guard text changed; update the alternative');
    await db.query(original.replace(needle, `${needle}\n  PERFORM 1 FROM "EntryExposureClaim" WHERE id=NEW."claimId" FOR UPDATE;`));
    try { alternative = await raceNotSentAgainstAdapter(); } finally { await db.query(original); }
  } finally { await db.query(`ALTER TRIGGER "EntryExposureClaimEvent_zz_external_signal_c2_delivery_fence" ON "EntryExposureClaimEvent" RENAME TO "${FIRST}"`); }
  check(S, 'I2c NEGATIVE CONTROL: if the order flips (the fence trigger renamed to sort after the guard) a NOT_SENT record is committed next to ADAPTER_INVOCATION_STARTED; the catalog order check catches the flip', !orderOk(orderAfterFlip) && flipped.bothRecorded === true, { orderAfterFlip: orderAfterFlip.map((r: any) => r.name), flipped });
  check(S, 'I2d trigger-independent alternative (the not-sent guard locks the claim itself, one added statement): the same flip no longer records NOT_SENT next to the adapter event', alternative.bothRecorded === false && alternative.notSent !== 'RECORDED', alternative);
  check(S, 'I2e the order is restored after the controls', orderOk(await triggerOrder()));

  // ---- I3: the security manifest. Baseline = the catalog AFTER the overlay (what the regenerated manifest would pin).
  {
    const reviewed = await readiness.readSecurityCatalog(sqlRows);
    const driftOfOverlay = readiness.compareWithManifest(reviewed, { functions: catalogBefore.functions, triggers: catalogBefore.triggers });
    const names = (a: any[]) => a.map(x => typeof x === 'string' ? x : x.function ?? x.trigger);
    (results as any).manifestDrift = { functionsChanged: names(driftOfOverlay.functionsChanged), functionsUnreviewed: driftOfOverlay.functionsUnreviewed, triggersChanged: names(driftOfOverlay.triggersChanged), triggersUnreviewed: driftOfOverlay.triggersUnreviewed, triggersMissing: driftOfOverlay.triggersMissing };
    check(S, 'I3a the overlay is visible to the C3B.1 manifest comparison: replaced functions are CHANGED and every new function and trigger is UNREVIEWED (the migration must regenerate the manifest in the same change)',
      names(driftOfOverlay.functionsChanged).includes('external_signal_broker_consumption_guard()') && names(driftOfOverlay.functionsChanged).includes('external_signal_broker_evidence_quarantine()') && driftOfOverlay.functionsUnreviewed.length >= 12 && driftOfOverlay.triggersUnreviewed.length >= 15 && driftOfOverlay.triggersMissing.length === 0,
      { changed: names(driftOfOverlay.functionsChanged), unreviewedFunctions: driftOfOverlay.functionsUnreviewed.length, unreviewedTriggers: driftOfOverlay.triggersUnreviewed.length });
    const diff = async () => { const live = await readiness.readSecurityCatalog(sqlRows); return readiness.compareWithManifest(live, reviewed); };
    const clean = await diff();
    check(S, 'I3b with the post-overlay catalog as the reviewed baseline the drift is empty', ['functionsChanged', 'functionsMissing', 'functionsUnreviewed', 'triggersChanged', 'triggersMissing', 'triggersUnreviewed'].every(k => (clean as any)[k].length === 0), clean);
    const T = 'EntryExposureClaimEvent';
    // renamed
    await db.query(`ALTER TRIGGER "${SECOND}" ON "${T}" RENAME TO "${SECOND}_x"`); const renamed = await diff(); await db.query(`ALTER TRIGGER "${SECOND}_x" ON "${T}" RENAME TO "${SECOND}"`);
    // disabled
    await db.query(`ALTER TABLE "${T}" DISABLE TRIGGER "${FIRST}"`); const disabled = await diff(); await db.query(`ALTER TABLE "${T}" ENABLE TRIGGER "${FIRST}"`);
    // rebound to another function
    await db.query(`CREATE FUNCTION r5_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await db.query(`DROP TRIGGER "${FIRST}" ON "${T}"`); await db.query(`CREATE TRIGGER "${FIRST}" BEFORE INSERT ON "${T}" FOR EACH ROW EXECUTE FUNCTION r5_noop()`); const rebound = await diff();
    await db.query(`DROP TRIGGER "${FIRST}" ON "${T}"`); await db.query(`CREATE TRIGGER "${FIRST}" BEFORE INSERT ON "${T}" FOR EACH ROW EXECUTE FUNCTION external_signal_c2_delivery_event_fence()`); await db.query('DROP FUNCTION r5_noop()');
    // altered body
    const body = (await db.query(`SELECT pg_get_functiondef('external_signal_c2_delivery_event_fence()'::regprocedure) AS def`)).rows[0].def as string;
    await db.query(body.replace('RETURN NEW; END IF;', 'RETURN NEW; END IF; -- altered')); const altered = await diff(); await db.query(body);
    const restored = await diff();
    check(S, 'I3c renamed trigger: reported missing AND unreviewed', renamed.triggersMissing.some((x: string) => x.endsWith(SECOND)) && renamed.triggersUnreviewed.some((x: string) => x.endsWith(`${SECOND}_x`)), { missing: renamed.triggersMissing, unreviewed: renamed.triggersUnreviewed });
    check(S, 'I3d disabled trigger: reported changed (enabled)', disabled.triggersChanged.some((x: any) => x.trigger.endsWith(FIRST) && x.fields.includes('enabled')), disabled.triggersChanged.map((x: any) => [x.trigger, x.fields]));
    check(S, 'I3e trigger rebound to another function: reported changed (function)', rebound.triggersChanged.some((x: any) => x.trigger.endsWith(FIRST) && x.fields.includes('function')), rebound.triggersChanged.map((x: any) => [x.trigger, x.fields]));
    check(S, 'I3f altered function body: reported changed (bodySha256)', altered.functionsChanged.some((x: any) => x.function === 'external_signal_c2_delivery_event_fence()' && x.fields.includes('bodySha256')), altered.functionsChanged);
    check(S, 'I3g every control is restored', ['functionsChanged', 'functionsMissing', 'functionsUnreviewed', 'triggersChanged', 'triggersMissing', 'triggersUnreviewed'].every(k => (restored as any)[k].length === 0), restored);

    // The preflight additions this revision proposes: every new object, and an ORDER invariant.
    const proposed = ['ExternalSignalDispatchFence/ExternalSignalDispatchFence_guard', 'ExternalSignalDispatchFence/ExternalSignalDispatchFence_truncate_guard', 'OrderIntent/OrderIntent_dispatch_fence_create', 'OrderIntent/OrderIntent_a_epoch_stamp',
      'BrokerOrder/BrokerOrder_dispatch_fence_bump', 'BrokerActivity/BrokerActivity_dispatch_fence_bump', 'EntryExposureClaim/EntryExposureClaim_dispatch_fence_bump', 'EntryExposureClaimEvent/EntryExposureClaimEvent_dispatch_fence_bump',
      'ExternalSignalBrokerDispatchConsumption/ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump', 'ExternalSignalBrokerDispatchConsumption/ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify',
      'MarketPolicyBrokerDispatchConsumption/BrokerDispatchConsumption_a_lock_prelude', 'Signal/Signal_received_at_guard', 'ExternalSignalTradeCycleAccount/ExternalSignalTradeCycleAccount_a_epoch_stamp'];
    const present = proposed.filter(k => k in reviewed.triggers);
    check(S, 'I3h every object proposed for CRITICAL_TRIGGERS exists in the overlay catalog', present.length === proposed.length, { proposed: proposed.length, present: present.length });
    const orderInvariantSql = `SELECT c.relname AS "table", array_agg(t.tgname::text ORDER BY t.tgname COLLATE "C") AS fire_order FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relname='EntryExposureClaimEvent' AND (t.tgtype & 2)<>0 AND (t.tgtype & 4)<>0 GROUP BY 1`;
    (results as any).proposedPreflightOrderInvariant = { sql: orderInvariantSql, expectedBefore: [[FIRST, SECOND]] };
  }
  // ---- I4: no new or replaced guard may swallow a serialization failure: plpgsql `EXCEPTION WHEN others` would catch a 40001/40P01 raised by a
  //          lock or fenced read inside it and let the transaction continue past the conflict.
  {
    const newFns = ['external_signal_broker_consumption_guard', 'external_signal_lock_dispatch_graph', 'external_signal_mi_consumption_lock_prelude', 'external_signal_dispatch_fence_guard', 'external_signal_dispatch_fence_create', 'external_signal_dispatch_fence_bump',
      'external_signal_dispatch_fence_consumption_verify', 'external_signal_broker_evidence_marked_intents', 'external_signal_marked_intent_broker_evidence', 'external_signal_broker_evidence_quarantine', 'external_signal_signal_received_at_guard'];
    const swallowing = (await db.query(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname = ANY($1) AND p.prosrc ~* 'EXCEPTION\\s+WHEN\\s+(others|serialization_failure|deadlock_detected)'`, [newFns])).rows.map((r: any) => r.proname);
    const existing = (await db.query(`SELECT p.proname FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'external_signal%' AND p.proname <> ALL($1) AND p.prosrc ~* 'EXCEPTION\\s+WHEN\\s+others' ORDER BY 1`, [newFns])).rows.map((r: any) => r.proname);
    check(S, 'I4 none of the new or replaced functions contains EXCEPTION WHEN others / serialization_failure (a swallowed 40001 would let the guard continue past a conflict); existing accepted functions that do are listed', swallowing.length === 0, { newOrReplacedThatSwallow: swallowing, existingWithWhenOthers: existing });
  }
  void results;
}

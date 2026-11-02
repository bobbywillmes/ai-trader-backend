// Section T of the revision-5 real-schema probes: execution clocks and activation epochs. Every comparison of a signal instant with an
// activation epoch must be timestamptz against timestamptz on the database clock. Measured here: the legacy `Signal.createdAt`
// comparison (a naive timestamp against a timestamptz) is TimeZone-dependent in BOTH directions, the receipt rule is not, activation
// epochs are database-stamped even when the application clock is wrong, and a source scan lists every remaining comparison.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readdir, readFile } from 'node:fs/promises';

export async function run(ctx: any) {
  const { db, check, attempt, claimed, admitted, fx, paperId, results } = ctx;
  const S = 'epoch';
  const ZONES = ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Asia/Tokyo', 'America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'Etc/GMT+12', 'PST8PDT'];

  // ---- T1: the legacy comparison versus the receipt rule, on a REAL signal and a real rollout state, across nine zones and three setters.
  {
    const g = await claimed();
    const sigId = (await db.query('SELECT "entrySignalId" AS id FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1', [g.intentId])).rows[0].id as number;
    const row = (await db.query(`SELECT s."createdAt" AS created_naive, s."receivedAt", st."activatedAt" FROM "Signal" s, "ExternalSignalBrokerDispatchState" st WHERE s.id=$1 AND st.id=1`, [sigId])).rows[0];
    const wrongSide: Record<string, { legacy: boolean; receipt: boolean }> = {};
    const wrongSideEast: Record<string, { legacy: boolean; receipt: boolean }> = {};
    const setters = {
      'SET TIME ZONE': (z: string) => db.query(`SET TIME ZONE '${z}'`),
      set_config: (z: string) => db.query(`SELECT set_config('TimeZone', $1, false)`, [z]),
      'SET LOCAL': async (z: string) => { await db.query('BEGIN'); await db.query(`SET LOCAL TIME ZONE '${z}'`); },
    } as const;
    let legacyWrongWest = 0, legacyWrongEast = 0, receiptWrong = 0, combos = 0;
    for (const [setterName, setter] of Object.entries(setters)) for (const zone of ZONES) {
      await setter(zone); combos += 1;
      // The signal was received BEFORE an epoch placed 30 s after it: truly ineligible. And AFTER an epoch placed 30 s before it: truly eligible.
      const q = await db.query(`SELECT (s."createdAt" >= (st."activatedAt" + interval '30 seconds')) AS legacy_late_epoch, (s."createdAt" >= (st."activatedAt" - interval '30 seconds' + (s."receivedAt" - st."activatedAt"))) AS legacy_early_epoch,
        external_signal_signal_received_since(s.id, s."receivedAt" + interval '30 seconds') AS receipt_late_epoch, external_signal_signal_received_since(s.id, s."receivedAt" - interval '30 seconds') AS receipt_early_epoch
        FROM "Signal" s, "ExternalSignalBrokerDispatchState" st WHERE s.id=$1 AND st.id=1`, [sigId]);
      if (setterName === 'SET LOCAL') await db.query('ROLLBACK');
      const r = q.rows[0];
      // legacy_late_epoch is wrong when true (accepted a signal received before the epoch)
      if (r.legacy_late_epoch === true) legacyWrongWest += 1;
      if (r.receipt_late_epoch === true || r.receipt_early_epoch === false) receiptWrong += 1;
      wrongSide[`${setterName} / ${zone}`] = { legacy: r.legacy_late_epoch, receipt: r.receipt_late_epoch };
      void legacyWrongEast; void wrongSideEast;
    }
    await db.query(`RESET TIME ZONE`);
    // The mirror error: an epoch 30 s BEFORE the receipt, evaluated against the createdAt naive value, refuses eligible signals in zones east of UTC.
    for (const zone of ZONES) {
      await db.query(`SET TIME ZONE '${zone}'`);
      const r = (await db.query(`SELECT (s."createdAt" >= (s."receivedAt" - interval '30 seconds')) AS legacy_early_epoch FROM "Signal" s WHERE s.id=$1`, [sigId])).rows[0];
      if (r.legacy_early_epoch === false) legacyWrongEast += 1;
      wrongSideEast[zone] = { legacy: r.legacy_early_epoch, receipt: true };
    }
    await db.query(`RESET TIME ZONE`);
    check(S, 'T1 `sig.createdAt >= <timestamptz epoch>` is TimeZone-dependent in both directions (accepts a pre-epoch signal west of UTC, refuses a post-epoch signal east of UTC); the receivedAt rule gives the correct answer in all 27 zone/setter combinations', legacyWrongWest > 0 && legacyWrongEast > 0 && receiptWrong === 0 && combos === 27,
      { combos, legacyAcceptedPreEpochSignalIn: legacyWrongWest, legacyRefusedPostEpochSignalIn: legacyWrongEast, receiptWrongAnswers: receiptWrong, sample: row });
    (results as any).epochMatrix = { acceptedPreEpoch: wrongSide, refusedPostEpochByZone: wrongSideEast };
  }

  // ---- T2: an historical (NULL receipt) signal is ineligible for every epoch comparison; the legacy comparison would admit it.
  {
    const g = await claimed();
    const sigId = (await db.query('SELECT "entrySignalId" AS id FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1', [g.intentId])).rows[0].id as number;
    await db.query('BEGIN'); await db.query(`SET LOCAL session_replication_role='replica'`); await db.query(`UPDATE "Signal" SET "receivedAt"=NULL WHERE id=$1`, [sigId]); await db.query('COMMIT');
    const r = (await db.query(`SELECT external_signal_signal_received_since(s.id, '1970-01-01'::timestamptz) AS since_epoch, external_signal_signal_receipt_open(s.id) AS open, (s."createdAt" >= st."activatedAt") AS legacy_admits FROM "Signal" s, "ExternalSignalBrokerDispatchState" st WHERE s.id=$1 AND st.id=1`, [sigId])).rows[0];
    check(S, 'T2 a signal with a NULL receipt is ineligible for any epoch and any open window (even the epoch 1970), while the legacy createdAt comparison would admit it', r.since_epoch === false && r.open === false && r.legacy_admits === true, r);
  }

  // ---- T3: the activation-epoch columns are ALREADY database-stamped by accepted C1 guards. The application clock is made WRONG (one hour slow)
  //           while the PRODUCTION grant service runs. Control: a Prisma @default(now()) column WITHOUT a stamp (SystemEvent.createdAt) is an hour behind.
  {
    const RealDate = Date; const skewMs = 3600_000;
    const slow = class extends RealDate { constructor(...a: any[]) { if (a.length === 0) super(RealDate.now() - skewMs); else super(...(a as [any])); } static override now() { return RealDate.now() - skewMs; } } as unknown as DateConstructor;
    (globalThis as any).Date = slow;
    let g: any; let event: any;
    try {
      g = await fx.admit(`t3-${Math.random().toString(36).slice(2, 6)}`);
      const { prisma } = await import('../../src/db/prisma.js');
      event = await prisma.systemEvent.create({ data: { type: 'R5_CLOCK_PROBE', entityType: 'probe', entityId: '1', severity: 'INFO', message: 'clock probe', payloadJson: {} } });
    } finally { (globalThis as any).Date = RealDate; }
    const row = (await db.query(`SELECT extract(epoch FROM (clock_timestamp() - a."authorizedAt")) AS auth_behind_s FROM "ExternalSignalEntryExecutionAuthorization" a JOIN "ExternalSignalEntryExecutionObligation" o ON o."authorizationId"=a.id WHERE o."orderIntentId"=$1`, [g.intentId])).rows[0];
    const ctl = (await db.query(`SELECT extract(epoch FROM (clock_timestamp() - "createdAt" AT TIME ZONE 'UTC')) AS ctl_behind_s FROM "SystemEvent" WHERE id=$1`, [event.id])).rows[0];
    const dbStampFns = (await db.query(`SELECT p.proname FROM pg_proc p WHERE p.proname IN ('external_signal_entry_authorization_guard','external_signal_broker_dispatch_activation_guard','external_signal_execution_rollout_activation_guard') AND (p.prosrc ~ 'NEW\."authorizedAt"\s*:=\s*statement_timestamp' OR p.prosrc ~ 'NEW\."createdAt"\s*:=\s*statement_timestamp') ORDER BY 1`)).rows.map((r: any) => r.proname);
    check(S, 'T3 the TradingView authorization epoch and both activation epochs are database-stamped by the accepted C1 guards: with the application clock one hour slow, authorizedAt is current, while an unstamped Prisma default-now column is an hour behind (control)', Number(row.auth_behind_s) >= 0 && Number(row.auth_behind_s) < 60 && Number(ctl.ctl_behind_s) > 3000 && dbStampFns.length === 3, { authorizedAtBehindSeconds: Number(row.auth_behind_s), unstampedControlBehindSeconds: Number(ctl.ctl_behind_s), guardsThatStamp: dbStampFns });
  }
  {
    const probe = async (stamp: string) => {
      await db.query('BEGIN');
      try {
        await db.query(`CREATE TEMP TABLE r5_stamp (id int, "createdAt" timestamptz) ON COMMIT DROP`);
        await db.query(`CREATE TRIGGER r5_stamp_t BEFORE INSERT ON r5_stamp FOR EACH ROW EXECUTE FUNCTION external_signal_epoch_created_at_stamp()`);
        const v = (await db.query(`INSERT INTO r5_stamp VALUES (1, ${stamp}) RETURNING extract(epoch FROM (clock_timestamp() - "createdAt")) AS lag`)).rows[0].lag;
        await db.query('ROLLBACK'); return Number(v);
      } catch (e) { await db.query('ROLLBACK'); throw e; }
    };
    const past = await probe(`now() - interval '1 day'`); const future = await probe(`now() + interval '1 day'`);
    check(S, 'T3b the candidate-side stamp function overwrites a supplied past or future createdAt with the database clock (Prisma always supplies one, so the value is overwritten, not rejected)', Math.abs(past) < 5 && Math.abs(future) < 5, { lagWhenSuppliedYesterday: past, lagWhenSuppliedTomorrow: future });
  }

  // ---- T4: the catalog audit: every database function body in the migrated schema that compares a signal creation time (for the doc table).
  {
    const fns = (await db.query(`SELECT p.proname AS fn FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.prosrc ILIKE '%signal_created_at%' OR p.prosrc ~* 'sig\\."createdAt"|signal\\."createdAt"') ORDER BY 1`)).rows.map((r: any) => r.fn);
    const files = (await readdir('src/services')).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const hits: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const lines = (await readFile(`src/services/${file}`, 'utf8')).split('\n');
      lines.forEach((text, i) => { if (/(sig|signal|entrySignal)\W{0,3}"?createdAt|signal_created_at|createdAt\)?\.getTime\(\)|\.createdAt\.getTime/.test(text) && /(signal|sig)/i.test(text)) hits.push({ file, line: i + 1, text: text.trim().slice(0, 150) }); });
    }
    (results as any).epochAudit = { databaseFunctions: fns, serviceLines: hits };
    check(S, 'T4 the audit scan finds the database functions and service lines that compare Signal.createdAt (listed in the document)', fns.length >= 1 && hits.length >= 3, { databaseFunctions: fns, serviceLineCount: hits.length });
  }
}

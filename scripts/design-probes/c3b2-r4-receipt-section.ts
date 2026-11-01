// Section B of the revision-4 real-schema probes: database-owned signal receipt time (see c3b2-r4-real-schema-probes.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */
import pg from 'pg';

export async function run(ctx: any) {
  const { db, check, attempt, mk, url, claimed } = ctx;
  const S = 'receipt';
  const graphs = [await claimed(), await claimed(), await claimed(), await claimed()];
  const signalIds: number[] = [];
  for (const g of graphs) signalIds.push((await db.query('SELECT "entrySignalId" AS id FROM "ExternalSignalEntryExecutionObligation" WHERE "orderIntentId"=$1', [g.intentId])).rows[0].id);

  // ---- B0: what the existing columns are, and why the existing comparison is session-dependent.
  const meta = (await db.query(`SELECT data_type, column_default FROM information_schema.columns WHERE table_name='Signal' AND column_name='createdAt'`)).rows[0];
  const receiptColumn = (await db.query(`SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name='Signal' AND column_name='receivedAt'`)).rows[0];
  check(S, 'B0 Signal.createdAt is timestamp without time zone with a session-TimeZone default; receivedAt is timestamptz with no default', meta.data_type === 'timestamp without time zone' && receiptColumn.data_type === 'timestamp with time zone' && receiptColumn.column_default === null, { createdAt: meta, receivedAt: receiptColumn });

  const zones = ['UTC', 'America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Etc/GMT+12', 'PST8PDT', 'Asia/Tokyo'];
  const setters: Array<[string, (c: any, z: string) => Promise<unknown>]> = [
    ['SET TIME ZONE', (c, z) => c.query(`SET TIME ZONE '${z}'`)],
    ['set_config', (c, z) => c.query(`SELECT set_config('TimeZone', $1, false)`, [z])],
    ['SET LOCAL in txn', (c, z) => c.query(`BEGIN`).then(() => c.query(`SET LOCAL TimeZone TO '${z}'`))],
  ];

  // Control rows: three signals with a database receipt of exactly known age (set with triggers off, disposable DB only).
  const ages: Record<string, number | null> = { stale200: 200, mid60: 60, fresh0: 0, historicalNull: null };
  const roles: Array<[string, number]> = [['stale200', signalIds[0]!], ['mid60', signalIds[1]!], ['fresh0', signalIds[2]!], ['historicalNull', signalIds[3]!]];
  await db.query('BEGIN');
  await db.query(`SET LOCAL session_replication_role='replica'`);
  for (const [name, id] of roles) {
    const age = ages[name];
    // createdAt is written the way Prisma writes it: UTC wall time in a timestamp(3) column.
    await db.query(`UPDATE "Signal" SET "receivedAt" = ${age === null ? 'NULL' : `clock_timestamp() - make_interval(secs => ${age})`}, "createdAt" = (clock_timestamp() - make_interval(secs => ${age ?? 3600})) AT TIME ZONE 'UTC' WHERE id=$1`, [id]);
  }
  await db.query('COMMIT');

  // ---- B1: freshness is identical under every TimeZone setting and every way of setting it; the legacy comparison is not.
  const expected: Record<string, boolean> = { stale200: false, mid60: true, fresh0: true, historicalNull: false };
  const evaluate = async (c: any) => {
    const out: Record<string, { receipt: boolean; legacy: boolean }> = {};
    for (const [name, id] of roles) {
      const r = (await c.query(`SELECT external_signal_signal_receipt_open($1) AS receipt, ("createdAt" + interval '120 seconds' > clock_timestamp()) AS legacy FROM "Signal" WHERE id=$1`, [id])).rows[0];
      out[name] = { receipt: r.receipt, legacy: r.legacy };
    }
    return out;
  };
  const table: Record<string, Record<string, string>> = {};
  let receiptStable = true; let legacyDiverges = false;
  const c = await mk(url);
  for (const [how, apply] of setters) {
    for (const zone of zones) {
      await apply(c, zone);
      const shown = (await c.query('SHOW TimeZone')).rows[0].TimeZone;
      const got = await evaluate(c);
      await c.query('ROLLBACK').catch(() => undefined);
      await c.query('RESET TimeZone').catch(() => undefined);
      for (const [name] of roles) {
        if (got[name]!.receipt !== expected[name]) receiptStable = false;
        if (got[name]!.legacy !== (name === 'fresh0' ? true : false) && name === 'stale200') legacyDiverges = true;
      }
      (table[how] ??= {})[zone] = `${shown === zone || how === 'SET LOCAL in txn' ? 'ok' : `shown:${shown}`}; receipt stale=${got.stale200!.receipt} legacy stale=${got.stale200!.legacy}`;
    }
  }
  check(S, 'B1 receivedAt freshness is the same for every zone and every way of setting it (stale=false, 60s=true, fresh=true, historical NULL=false)', receiptStable, table);
  check(S, 'B1b negative control: the legacy createdAt comparison accepts a 200-second-old signal in at least one session time zone', legacyDiverges);

  // Connection-level and database-level TimeZone (startup parameter, ALTER DATABASE) as well.
  const viaStartup: Record<string, boolean> = {};
  for (const zone of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const client = new pg.Client({ connectionString: url, options: `-c TimeZone=${zone}` }); await client.connect();
    const got = await evaluate(client); viaStartup[zone] = Object.entries(got).every(([name, v]) => v.receipt === expected[name]); await client.end();
  }
  const dbName = (await db.query('SELECT current_database() AS d')).rows[0].d;
  await db.query(`ALTER DATABASE ${dbName} SET TimeZone TO 'America/Los_Angeles'`);
  const dbDefault = await mk(url); const got = await evaluate(dbDefault); await dbDefault.end();
  await db.query(`ALTER DATABASE ${dbName} RESET TimeZone`);
  check(S, 'B1c startup-parameter and ALTER DATABASE time zones cannot extend the window', Object.values(viaStartup).every(Boolean) && Object.entries(got).every(([name, v]) => v.receipt === expected[name]), { viaStartup, databaseLevel: got });

  // ---- B2: the database owns the stamp. Inserts are made in a rolled-back transaction by copying a real signal row.
  const columns = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='Signal' AND column_name NOT IN ('id','receivedAt') ORDER BY ordinal_position`)).rows.map((r: any) => `"${r.column_name}"`);
  const copyList = columns.join(',');
  const selectList = columns.map((col: string) => {
    if (col === '"externalEventId"') return `'r4-' || gen_random_uuid()::text`;
    if (col === '"externalEventKey"') return `NULL`;
    if (col === '"event"') return `'EXIT_LONG'::"SignalEvent"`;
    if (col === '"eventFingerprint"' || col === '"canonicalPayloadHash"') return `encode(sha256(gen_random_uuid()::text::bytea),'hex')`;
    return col;
  }).join(',');
  const insertCopy = (client: any, extra: string, values: unknown[] = []) => attempt(client, `INSERT INTO "Signal" (${copyList}${extra ? `,${extra.split('=')[0]}` : ''}) SELECT ${selectList}${extra ? `,${extra.split('=')[1]}` : ''} FROM "Signal" WHERE id=${signalIds[2]} RETURNING id, "receivedAt", "createdAt"`, values);
  {
    const t = await mk(url);
    await t.query('BEGIN'); await t.query('SELECT pg_sleep(2)');
    const stamped = await insertCopy(t, '');
    await t.query('ROLLBACK'); await t.query('BEGIN');
    const supplied = await insertCopy(t, '"receivedAt"=now() - interval \'1 hour\'');
    await t.query('ROLLBACK');
    const rid = stamped.rows?.[0];
    const ageMs = rid ? Date.now() - new Date(rid.receivedAt).getTime() : null;
    check(S, 'B2 insert is stamped by the database at transaction start (conservative: earlier than the insert after a 2 s stall) and a supplied value is rejected',
      Boolean(stamped.ok) && Boolean(rid?.receivedAt) && !supplied.ok && /database-owned/.test(supplied.message ?? ''), { stamped: stamped.ok ? { receivedAt: rid.receivedAt, ageMsAtRead: ageMs } : stamped.message, supplied: supplied.message });
    await t.end();
  }
  {
    const t = await mk(url); await t.query('BEGIN');
    await t.query(`SET LOCAL TimeZone TO 'Pacific/Kiritimati'`);
    const a = await insertCopy(t, '');
    await t.query('ROLLBACK'); await t.query('BEGIN'); await t.query(`SET LOCAL TimeZone TO 'Pacific/Kiritimati'`);
    const advanced = await insertCopy(t, '"receivedAt"=now() + interval \'1 hour\'');
    await t.query('ROLLBACK'); await t.end();
    check(S, 'B2b a hostile session time zone does not shift the stamp, and an advanced value is rejected', Boolean(a.ok) && !advanced.ok, { stampedUnderKiritimati: a.rows?.[0]?.receivedAt, advanced: advanced.message });
  }

  // ---- B3: immutability, including historical NULL rows (they can never be given a receipt).
  const upd = await attempt(db, `UPDATE "Signal" SET "receivedAt" = "receivedAt" + interval '1 hour' WHERE id=$1`, [signalIds[2]]);
  const fill = await attempt(db, `UPDATE "Signal" SET "receivedAt" = now() WHERE id=$1`, [signalIds[3]]);
  const clear = await attempt(db, `UPDATE "Signal" SET "receivedAt" = NULL WHERE id=$1`, [signalIds[2]]);
  check(S, 'B3 receivedAt cannot be changed, filled in for a historical NULL row, or cleared', !upd.ok && !fill.ok && !clear.ok, { upd: upd.message, fill: fill.message, clear: clear.message });

  // ---- B4: ADD COLUMN ... DEFAULT now() is the backfill trap; the design adds the column without a default.
  await db.query(`CREATE TEMP TABLE backfill_old (id int, created timestamp)`);
  await db.query(`INSERT INTO backfill_old VALUES (1, (now() - interval '30 days') AT TIME ZONE 'UTC')`);
  await db.query(`ALTER TABLE backfill_old ADD COLUMN trap timestamptz DEFAULT now(), ADD COLUMN safe timestamptz`);
  const trap = (await db.query(`SELECT (trap + make_interval(secs=>120) > clock_timestamp()) AS looks_fresh, (safe IS NULL) AS safe_null FROM backfill_old`)).rows[0];
  check(S, 'B4 negative control: ADD COLUMN DEFAULT now() makes a 30-day-old row look fresh; the default-less column leaves it NULL (fails closed)', trap.looks_fresh === true && trap.safe_null === true, trap);

  // ---- B5: DST/calendar pitfalls of interval arithmetic: the window must be expressed in seconds only.
  await db.query(`SET TIME ZONE 'America/New_York'`);
  const dst = (await db.query(`SELECT ('2026-03-07 12:00:00+00'::timestamptz + interval '1 day') AS day_ny, ('2026-03-07 12:00:00+00'::timestamptz + make_interval(secs => 86400)) AS secs_ny`)).rows[0];
  await db.query(`SET TIME ZONE 'UTC'`);
  const dstUtc = (await db.query(`SELECT ('2026-03-07 12:00:00+00'::timestamptz + interval '1 day') AS day_utc`)).rows[0];
  check(S, 'B5 interval \'1 day\' is session/DST dependent while a seconds interval is absolute (so the window is make_interval(secs => 120))', dst.day_ny.getTime() !== dstUtc.day_utc.getTime() && dst.secs_ny.getTime() === dstUtc.day_utc.getTime(), { dayInNewYork: dst.day_ny, dayInUtc: dstUtc.day_utc, secondsInNewYork: dst.secs_ny });
  await c.end();
}

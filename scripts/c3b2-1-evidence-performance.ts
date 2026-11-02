import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { createDisposablePostgresDatabase } from '../src/db/__tests__/disposable-postgres.js';

// Phase 4A.2C3B.2-1 performance measurement of the new evidence-identity lookup and the dispatch-fence triggers on UNMARKED PAPER/LIVE traffic
// (the hot path that must stay cheap). Runs only in a disposable database created on the server named by DATABASE_URL, executes every loop
// server side (so network round trips do not dilute the figures) and drops the database afterwards.
//   tsx scripts/c3b2-1-evidence-performance.ts [--rows 20000] [--ops 5000] [--out docs/architecture/tradingview-c3b2-1-performance-pg16.json]
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1]! : fallback; };
const ROWS = Number(arg('rows', '20000'));
const OPS = Number(arg('ops', '5000'));
const OUT = arg('out', '');
const KEEP = process.argv.includes('--keep');

const database = await createDisposablePostgresDatabase(process.env.DATABASE_URL!, 'c3b21perf');
const client = new Client({ connectionString: database.url });
try {
  await database.migrate();
  await client.connect();
  const version = (await client.query('SHOW server_version')).rows[0].server_version as string;
  const userId = (await client.query(`INSERT INTO "User" (email,"platformRole",enabled,"createdAt","updatedAt") VALUES ('perf@test','SYSTEM_OWNER',true,now(),now()) RETURNING id`)).rows[0].id as number;
  const accounts = [] as number[];
  for (const environment of ['PAPER', 'LIVE']) accounts.push((await client.query(`INSERT INTO "TradingAccount" ("accountHolderUserId","displayName",environment,status,"tradingEnabled","killSwitchEnabled","tradingBlocked","createdAt","updatedAt") VALUES ($1,$2,$3::"TradingAccountEnvironment",'PAUSED',false,true,false,now(),now()) RETURNING id`, [userId, `perf ${environment}`, environment])).rows[0].id as number);
  const securityId = (await client.query(`INSERT INTO "Security" (symbol,name,enabled,"assetType","createdAt","updatedAt") VALUES ('PERF','PERF',true,'STOCK',now(),now()) RETURNING id`)).rows[0].id as number;

  // Bulk history: ROWS unmarked intents with an order and an activity each, spread over the two accounts (the shape of a mature database).
  await client.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","createdAt","updatedAt")
    SELECT 'manual','PERF','sell','market','day','filled','perf-' || g,'{}',($1::int[])[1 + g % 2],now(),now() FROM generate_series(1,$2) g`, [accounts, ROWS]);
  await client.query(`INSERT INTO "BrokerOrder" ("orderIntentId","tradingAccountId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","updatedAt","securityId")
    SELECT i.id,i."tradingAccountId",'alpaca','BO-' || i.id,i."clientOrderId",'PERF','sell','filled','{}',now(),$1 FROM "OrderIntent" i`, [securityId]);
  await client.query(`INSERT INTO "BrokerActivity" ("tradingAccountId","orderIntentId","orderId","brokerOrderRecordId",broker,mode,"activityId","activityType","rawBrokerJson","updatedAt")
    SELECT b."tradingAccountId",b."orderIntentId",b."brokerOrderId",b.id,'alpaca','paper','seed-' || b.id,'FILL','{}',now() FROM "BrokerOrder" b`);
  await client.query('ANALYZE');

  const modes: Array<[label: string, off: Array<[table: string, trigger: string]>]> = [
    ['all triggers (C3B.2-1)', []],
    ['fence bump triggers off (quarantine only)', [['BrokerOrder', 'BrokerOrder_dispatch_fence_bump'], ['BrokerActivity', 'BrokerActivity_dispatch_fence_bump'], ['OrderIntent', 'OrderIntent_dispatch_fence_bump'], ['EntryExposureClaim', 'EntryExposureClaim_dispatch_fence_bump'], ['EntryExposureClaimEvent', 'EntryExposureClaimEvent_dispatch_fence_bump']]],
    ['pre-C3B.2-1 (bump and new quarantine logic bypassed)', [['BrokerOrder', 'BrokerOrder_dispatch_fence_bump'], ['BrokerActivity', 'BrokerActivity_dispatch_fence_bump'], ['OrderIntent', 'OrderIntent_dispatch_fence_bump'], ['EntryExposureClaim', 'EntryExposureClaim_dispatch_fence_bump'], ['EntryExposureClaimEvent', 'EntryExposureClaimEvent_dispatch_fence_bump'], ['BrokerOrder', 'BrokerOrder_external_signal_quarantine'], ['BrokerActivity', 'BrokerActivity_external_signal_quarantine']]],
  ];
  const scenarios: Array<[label: string, sql: string]> = [
    ['BrokerOrder INSERT (unmarked)', `FOR i IN 1..$1 LOOP INSERT INTO "BrokerOrder" ("orderIntentId","tradingAccountId",broker,"brokerOrderId","clientOrderId",symbol,side,status,"rawBrokerJson","updatedAt","securityId") SELECT oi.id,oi."tradingAccountId",'alpaca','NEW-' || clock_timestamp() || i,'new-' || clock_timestamp() || i,'PERF','sell','accepted','{}',now(),$2 FROM "OrderIntent" oi WHERE oi.id = 1 + (i % $3); END LOOP;`],
    ['BrokerOrder status UPDATE (the order-sync hot path)', `FOR i IN 1..$1 LOOP UPDATE "BrokerOrder" SET status = CASE WHEN status = 'filled' THEN 'accepted' ELSE 'filled' END, "updatedAt" = now() WHERE id = 1 + (i % $3); END LOOP;`],
    ['BrokerActivity INSERT linked by order id and record id', `FOR i IN 1..$1 LOOP INSERT INTO "BrokerActivity" ("tradingAccountId","orderIntentId","orderId","brokerOrderRecordId",broker,mode,"activityId","activityType","rawBrokerJson","updatedAt") SELECT b."tradingAccountId",b."orderIntentId",b."brokerOrderId",b.id,'alpaca','paper','p-' || clock_timestamp() || i,'FILL','{}',now() FROM "BrokerOrder" b WHERE b.id = 1 + (i % $3); END LOOP;`],
    ['BrokerActivity UPDATE (later attribution)', `FOR i IN 1..$1 LOOP UPDATE "BrokerActivity" SET "activityType" = 'FILL', "updatedAt" = now() WHERE id = 1 + (i % $3); END LOOP;`],
    ['OrderIntent status UPDATE (unmarked)', `FOR i IN 1..$1 LOOP UPDATE "OrderIntent" SET status = CASE WHEN status = 'filled' THEN 'partially_filled' ELSE 'filled' END, "updatedAt" = now() WHERE id = 1 + (i % $3); END LOOP;`],
  ];
  const results: Array<{ population: string; scenario: string; mode: string; microsecondsPerOp: number }> = [];
  const measure = async (population: string) => {
    let lastMs = NaN;
    client.on('notice', notice => { const match = /ms=([0-9.]+)/.exec(notice.message ?? ''); if (match) lastMs = Number(match[1]); });
    for (const [scenario, loop] of scenarios) {
      for (const [label, off] of modes) {
        for (const [table, trigger] of off) await client.query(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
        try {
          const body = `DO $do$ DECLARE t0 timestamptz := clock_timestamp(); n integer := ${OPS}; i integer; BEGIN ${loop.replaceAll('$1', 'n').replaceAll('$2', String(securityId)).replaceAll('$3', String(ROWS))} RAISE NOTICE 'ms=%', extract(epoch FROM clock_timestamp() - t0) * 1000; END $do$`;
          const samples: number[] = [];
          for (let repeat = 0; repeat < 3; repeat += 1) { lastMs = NaN; await client.query('BEGIN'); await client.query(body); await client.query('ROLLBACK'); samples.push(lastMs); }
          samples.sort((x, y) => x - y);
          results.push({ population, scenario, mode: label, microsecondsPerOp: Math.round(samples[1]! * 1000 / OPS * 10) / 10 });
        } finally { for (const [table, trigger] of off) await client.query(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`); }
      }
    }

  };
  await measure('accounts WITHOUT marked TradingView intents (every LIVE account, any PAPER account without TradingView traffic)');
  // Worst case: both accounts now also own marked intents, so every broker row takes the full candidate path. Replica mode lets the disposable
  // fixture create marked intents without building their whole authority graph; their fences are written the way the migration backfill does.
  await client.query('BEGIN');
  await client.query(`SET LOCAL session_replication_role='replica'`);
  await client.query(`INSERT INTO "OrderIntent" (source,symbol,side,"orderType","timeInForce",status,"clientOrderId","rawRequestJson","tradingAccountId","externalSignalAccountCycleId","createdAt","updatedAt")
    SELECT 'tradingview','PERF','buy','market','day','blocked','marked-' || g,'{}',($1::int[])[1 + g % 2],900000 + g,now(),now() FROM generate_series(1,200) g`, [accounts]);
  await client.query(`INSERT INTO "ExternalSignalDispatchFence" ("orderIntentId", version) SELECT id, 1 FROM "OrderIntent" WHERE "externalSignalAccountCycleId" IS NOT NULL`);
  await client.query('COMMIT');
  await client.query('ANALYZE "OrderIntent"');
  await measure('accounts WITH marked TradingView intents (worst case: every broker row takes the full candidate path)');

  // Plans of the shared evidence-identity function: an unmarked order (the hot path), a marked intent's order and the reverse lookup.
  const plan = async (label: string, sql: string, params: unknown[]) => ({ label, plan: (await client.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING ON) ${sql}`, params)).rows.map(row => row['QUERY PLAN'] as string) });
  const plans = [
    await plan('evidence key for an unmarked PAPER order', `SELECT m FROM external_signal_broker_evidence_marked_intents($1,$2,$3,$4,NULL) m`, [5, 'perf-5', 'BO-5', accounts[0]]),
    await plan('evidence key for an unmarked activity (record id)', `SELECT m FROM external_signal_broker_evidence_marked_intents($1,NULL,$2,$3,$4) m`, [6, 'BO-6', accounts[1], 6]),
    await plan('absence check for one marked intent', `SELECT * FROM external_signal_marked_intent_broker_evidence($1)`, [1]),
  ];

  const report = { server: version, rows: ROWS, operationsPerLoop: OPS, results, plans };
  const lines = ['| population | scenario | mode | µs/op |', '|---|---|---|---|', ...results.map(r => `| ${r.population.startsWith('accounts WITHOUT') ? 'no marked intents' : 'marked intents present'} | ${r.scenario} | ${r.mode} | ${r.microsecondsPerOp} |`)];
  console.log(`PostgreSQL ${version}, ${ROWS} historical unmarked intents/orders/activities, ${OPS} operations per cell\n${lines.join('\n')}`);
  for (const p of plans) console.log(`\n-- ${p.label}\n${p.plan.join('\n')}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2));
} finally {
  await client.end().catch(() => undefined);
  if (KEEP) console.log(`kept ${database.url}`); else await database.drop();
}

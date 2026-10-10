import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_INTEGRITY_TESTS === '1' && process.env.DATABASE_URL;

(enabled ? describe : describe.skip)('OrderIntent market-policy capture trigger feasibility', () => {
  const database = `market_policy_capture_feasibility_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let db: Client;
  let databaseUrl: string;

  async function client() {
    const connection = new Client({ connectionString: databaseUrl });
    await connection.connect();
    return connection;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${database}`;
    url.searchParams.delete('schema');
    databaseUrl = url.toString();
    db = await client();
    await db.query(`
      CREATE TABLE capture_rollout (singleton boolean PRIMARY KEY DEFAULT true, enabled boolean NOT NULL DEFAULT true, inject_failure boolean NOT NULL DEFAULT false);
      INSERT INTO capture_rollout DEFAULT VALUES;
      CREATE TABLE assignment (id integer PRIMARY KEY, account_id integer NOT NULL);
      CREATE TABLE policy (id integer PRIMARY KEY, strategy_id integer NOT NULL, active_revision_id integer);
      CREATE TABLE enrollment_generation (id integer PRIMARY KEY, assignment_id integer NOT NULL, account_id integer NOT NULL, bound_revision_id integer NOT NULL, status text NOT NULL);
      CREATE TABLE intent (id bigserial PRIMARY KEY, assignment_id integer, account_id integer, side text NOT NULL, status text NOT NULL, risk_decision text, client_order_id text);
      CREATE TABLE capture (intent_id bigint PRIMARY KEY, assignment_id integer NOT NULL, account_id integer NOT NULL, enrollment_generation_id integer, bound_revision_id integer, active_revision_id integer, provenance text NOT NULL);
      INSERT INTO assignment VALUES (10, 20);
      INSERT INTO policy VALUES (30, 40, 50);
      INSERT INTO enrollment_generation VALUES (60, 10, 20, 50, 'ACTIVE');

      CREATE FUNCTION capture_intent_compare_only() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE generation_id integer; bound_revision integer; active_revision integer;
      BEGIN
        BEGIN
          IF (SELECT inject_failure FROM capture_rollout WHERE singleton) THEN
            RAISE EXCEPTION 'injected comparison failure';
          END IF;
          SELECT g.id, g.bound_revision_id, p.active_revision_id
            INTO generation_id, bound_revision, active_revision
            FROM assignment a
            JOIN enrollment_generation g ON g.assignment_id = a.id AND g.status = 'ACTIVE'
            JOIN policy p ON p.strategy_id = 40
            WHERE a.id = NEW.assignment_id AND a.account_id = NEW.account_id;
          INSERT INTO capture VALUES (
            NEW.id, NEW.assignment_id, NEW.account_id, generation_id, bound_revision, active_revision,
            CASE WHEN generation_id IS NULL THEN 'UNENROLLED'
                 WHEN bound_revision = active_revision THEN 'ACTIVE_EXACT'
                 ELSE 'SUPERSEDED' END
          );
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        RETURN NEW;
      END $$;
      CREATE TRIGGER intent_capture AFTER INSERT ON intent FOR EACH ROW
        WHEN (NEW.side = 'buy' AND NEW.assignment_id IS NOT NULL AND NEW.account_id IS NOT NULL)
        EXECUTE FUNCTION capture_intent_compare_only();
    `);
  });

  afterAll(async () => {
    if (db) await db.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end();
    }
  });

  it('contains realistic comparison failures without changing the inserted intent', async () => {
    await db.query(`UPDATE capture_rollout SET inject_failure = true`);
    const inserted = (await db.query(`INSERT INTO intent (assignment_id,account_id,side,status,risk_decision,client_order_id) VALUES (10,20,'buy','received','ALLOW','stable-1') RETURNING *`)).rows[0];
    expect(inserted).toMatchObject({ status: 'received', risk_decision: 'ALLOW', client_order_id: 'stable-1' });
    expect((await db.query(`SELECT count(*)::int count FROM capture WHERE intent_id=$1`, [inserted.id])).rows[0].count).toBe(0);
    await db.query(`UPDATE capture_rollout SET inject_failure = false`);
  });

  it('works for standalone inserts and inside an interactive transaction without changing order fields', async () => {
    const standalone = (await db.query(`INSERT INTO intent (assignment_id,account_id,side,status,risk_decision,client_order_id) VALUES (10,20,'buy','received','ALLOW','stable-2') RETURNING *`)).rows[0];
    expect((await db.query(`SELECT provenance FROM capture WHERE intent_id=$1`, [standalone.id])).rows[0].provenance).toBe('ACTIVE_EXACT');

    await db.query('BEGIN');
    const interactive = (await db.query(`INSERT INTO intent (assignment_id,account_id,side,status,risk_decision,client_order_id) VALUES (10,20,'buy','received','ALLOW','stable-live') RETURNING *`)).rows[0];
    await db.query(`UPDATE intent SET status='pending' WHERE id=$1`, [interactive.id]);
    await db.query('COMMIT');
    expect((await db.query(`SELECT status,risk_decision,client_order_id FROM intent WHERE id=$1`, [interactive.id])).rows[0]).toEqual({ status: 'pending', risk_decision: 'ALLOW', client_order_id: 'stable-live' });
    expect((await db.query(`SELECT provenance FROM capture WHERE intent_id=$1`, [interactive.id])).rows[0].provenance).toBe('ACTIVE_EXACT');
  });

  it.each(['READ COMMITTED', 'REPEATABLE READ'] as const)('uses one coherent committed snapshot under %s', async isolation => {
    const writer = await client();
    const inserter = await client();
    try {
      await inserter.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await writer.query('BEGIN');
      await writer.query(`UPDATE policy SET active_revision_id=51 WHERE id=30`);
      const beforeCommit = (await inserter.query(`INSERT INTO intent (assignment_id,account_id,side,status,client_order_id) VALUES (10,20,'buy','received',$1) RETURNING id`, [`iso-before-${isolation}`])).rows[0];
      expect((await inserter.query(`SELECT bound_revision_id,active_revision_id,provenance FROM capture WHERE intent_id=$1`, [beforeCommit.id])).rows[0]).toEqual({ bound_revision_id: 50, active_revision_id: 50, provenance: 'ACTIVE_EXACT' });
      await writer.query('ROLLBACK');
      await inserter.query('COMMIT');

      await writer.query('BEGIN');
      await writer.query(`UPDATE policy SET active_revision_id=51 WHERE id=30`);
      await writer.query('COMMIT');
      const afterCommit = (await db.query(`INSERT INTO intent (assignment_id,account_id,side,status,client_order_id) VALUES (10,20,'buy','received',$1) RETURNING id`, [`iso-after-${isolation}`])).rows[0];
      expect((await db.query(`SELECT bound_revision_id,active_revision_id,provenance FROM capture WHERE intent_id=$1`, [afterCommit.id])).rows[0]).toEqual({ bound_revision_id: 50, active_revision_id: 51, provenance: 'SUPERSEDED' });
      await db.query(`UPDATE policy SET active_revision_id=50 WHERE id=30`);
    } finally {
      await writer.end();
      await inserter.end();
    }
  });

  it('does not block on uncommitted prepare, activate, disable, or revision replacement writes', async () => {
    const writer = await client();
    const reader = await client();
    try {
      for (const statements of [
        [`INSERT INTO enrollment_generation VALUES (61,10,20,50,'PREPARED')`],
        [`INSERT INTO enrollment_generation VALUES (61,10,20,50,'PREPARED')`, `UPDATE enrollment_generation SET status='DISABLED' WHERE id=60`, `UPDATE enrollment_generation SET status='ACTIVE' WHERE id=61`],
        [`UPDATE enrollment_generation SET status='DISABLED' WHERE id=60`],
        [`UPDATE policy SET active_revision_id=51 WHERE id=30`],
      ]) {
        await writer.query('BEGIN');
        for (const statement of statements) await writer.query(statement);
        await reader.query(`SET statement_timeout='750ms'`);
        const started = performance.now();
        await reader.query(`INSERT INTO intent (assignment_id,account_id,side,status,client_order_id) VALUES (10,20,'buy','received','nonblocking')`);
        expect(performance.now() - started).toBeLessThan(700);
        await writer.query('ROLLBACK');
      }
    } finally {
      await writer.end();
      await reader.end();
    }
  });

  it('adds bounded local overhead without locks or deadlocks', async () => {
    const started = performance.now();
    await db.query(`INSERT INTO intent (assignment_id,account_id,side,status,client_order_id)
      SELECT 10,20,'buy','received','latency-' || value FROM generate_series(1,500) value`);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(2_000);
    expect((await db.query(`SELECT count(*)::int count FROM capture c JOIN intent i ON i.id=c.intent_id WHERE i.client_order_id LIKE 'latency-%'`)).rows[0].count).toBe(500);
  });
});

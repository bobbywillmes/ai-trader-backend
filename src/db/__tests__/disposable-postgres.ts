import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const DISPOSABLE_DATABASE_PREFIX = 'ai_trader_test_';

function databaseName(url: string) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

export function assertDisposableDatabaseUrl(url: string, expectedDatabase: string) {
  const actualDatabase = databaseName(url);
  if (!expectedDatabase.startsWith(DISPOSABLE_DATABASE_PREFIX) || actualDatabase !== expectedDatabase) {
    throw new Error(
      `Refusing database test writes: expected disposable database ${expectedDatabase}, received ${actualDatabase || '<none>'}.`,
    );
  }
}

export type DisposablePostgresDatabase = Awaited<ReturnType<typeof createDisposablePostgresDatabase>>;

export async function createDisposablePostgresDatabase(sourceUrl: string, label: string) {
  const database = `${DISPOSABLE_DATABASE_PREFIX}${label}_${randomUUID().replaceAll('-', '')}`;
  const sourceDatabase = databaseName(sourceUrl);
  if (!sourceDatabase || sourceDatabase === database) {
    throw new Error('Refusing to create a disposable test database from an invalid or already-targeted DATABASE_URL.');
  }

  const admin = new Client({ connectionString: sourceUrl });
  let created = false;
  try {
    await admin.connect();
    const sourceIdentity = await admin.query<{ database: string }>('SELECT current_database() AS database');
    if (sourceIdentity.rows[0]?.database !== sourceDatabase) {
      throw new Error('DATABASE_URL identity does not match the connected PostgreSQL database.');
    }

    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    const target = new URL(sourceUrl);
    target.pathname = `/${database}`;
    target.searchParams.delete('schema');
    const url = target.toString();
    assertDisposableDatabaseUrl(url, database);

    const verifier = new Client({ connectionString: url });
    try {
      await verifier.connect();
      const identity = await verifier.query<{ database: string }>('SELECT current_database() AS database');
      if (identity.rows[0]?.database !== database) {
        throw new Error(`Disposable database verification failed: connected to ${identity.rows[0]?.database ?? '<unknown>'}.`);
      }
    } finally {
      await verifier.end();
    }

    return {
      admin,
      database,
      url,
      async migrate() {
        assertDisposableDatabaseUrl(url, database);
        const result = spawnSync(
          process.execPath,
          ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
          { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 120_000 },
        );
        if (result.status !== 0) {
          throw new Error(`Failed to migrate disposable database ${database}: ${result.stderr || result.stdout}`);
        }
      },
      async verify() {
        assertDisposableDatabaseUrl(url, database);
        const client = new Client({ connectionString: url });
        try {
          await client.connect();
          const identity = await client.query<{ database: string }>('SELECT current_database() AS database');
          if (identity.rows[0]?.database !== database) {
            throw new Error(`Refusing database test writes: connected to ${identity.rows[0]?.database ?? '<unknown>'}.`);
          }
        } finally {
          await client.end();
        }
      },
      async drop() {
        assertDisposableDatabaseUrl(url, database);
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await admin.end();
      },
    };
  } catch (error) {
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    throw error;
  }
}

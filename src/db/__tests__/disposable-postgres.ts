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

export const MAINTENANCE_DATABASE = 'postgres';

/** The same server and credentials, bound to the maintenance database that issues CREATE/DROP DATABASE. */
export function maintenanceDatabaseUrl(sourceUrl: string) {
  const url = new URL(sourceUrl);
  url.pathname = `/${MAINTENANCE_DATABASE}`;
  url.searchParams.delete('schema');
  return url.toString();
}

/**
 * Connects the administrative client for disposable databases to the maintenance database, verified
 * by identity, so no test fixture or scratch statement ever runs in the application database. Falls
 * back to the source database only where the server has no usable maintenance database; CREATE and
 * DROP DATABASE write nothing into the connected database either way.
 */
export async function connectMaintenanceClient(sourceUrl: string) {
  const maintenance = new Client({ connectionString: maintenanceDatabaseUrl(sourceUrl) });
  try {
    await maintenance.connect();
    const identity = await maintenance.query<{ database: string }>('SELECT current_database() AS database');
    if (identity.rows[0]?.database !== MAINTENANCE_DATABASE) throw new Error('Maintenance database identity mismatch.');
    return { client: maintenance, database: MAINTENANCE_DATABASE };
  } catch {
    await maintenance.end().catch(() => undefined);
    const fallback = new Client({ connectionString: sourceUrl });
    await fallback.connect();
    const identity = await fallback.query<{ database: string }>('SELECT current_database() AS database');
    if (identity.rows[0]?.database !== databaseName(sourceUrl)) {
      await fallback.end().catch(() => undefined);
      throw new Error('DATABASE_URL identity does not match the connected PostgreSQL database.');
    }
    return { client: fallback, database: databaseName(sourceUrl) };
  }
}

export type DisposablePostgresDatabase = Awaited<ReturnType<typeof createDisposablePostgresDatabase>>;

export async function createDisposablePostgresDatabase(sourceUrl: string, label: string) {
  const database = `${DISPOSABLE_DATABASE_PREFIX}${label}_${randomUUID().replaceAll('-', '')}`;
  const sourceDatabase = databaseName(sourceUrl);
  if (!sourceDatabase || sourceDatabase === database) {
    throw new Error('Refusing to create a disposable test database from an invalid or already-targeted DATABASE_URL.');
  }

  const { client: admin } = await connectMaintenanceClient(sourceUrl);
  let created = false;
  try {
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

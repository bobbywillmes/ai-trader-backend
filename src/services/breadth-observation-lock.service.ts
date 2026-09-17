import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';

// Independent lock scope from market-daily-evidence (SPY/RSP bars): Breadth observation
// writes (bootstrap import and live ingestion) never contend with unrelated bar syncing.
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
const key = createHash('sha256').update('ai-trader:breadth-observation-ingestion').digest().readBigInt64BE(0).toString();
export async function withBreadthObservationLock<T>(execute: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let acquired = false; let damaged = false;
  const onError = () => { damaged = true; };
  client.on('error', onError);
  try {
    acquired = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) acquired', [key])).rows[0]?.acquired === true;
    if (!acquired) throw new HttpError(409, 'Breadth observation ingestion is already running.');
    return await execute();
  } finally {
    if (acquired) { try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]); } catch { damaged = true; } }
    client.off('error', onError);
    client.release(damaged);
  }
}
export async function closeBreadthObservationLockPool() { await pool.end(); }

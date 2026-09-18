import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { env } from '../config/env.js';
import { HttpError } from '../errors/http-error.js';

// Account-independent work has its own lock scope, never a fabricated trading account.
const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
const key = createHash('sha256').update('ai-trader:market-daily-evidence').digest().readBigInt64BE(0).toString();
export async function withMarketDataLock<T>(execute: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let acquired = false; let damaged = false;
  const onError = () => { damaged = true; };
  client.on('error', onError);
  try {
    acquired = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) acquired', [key])).rows[0]?.acquired === true;
    if (!acquired) throw new HttpError(409, 'Market data synchronization is already running.');
    return await execute();
  } finally {
    if (acquired) { try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]); } catch { damaged = true; } }
    client.off('error', onError);
    client.release(damaged);
  }
}
export async function closeMarketDataLockPool() { await pool.end(); }

import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { ACCEPTANCE_API_PORT, ACCEPTANCE_DATABASE, ACCEPTANCE_DB_HOSTS, ACCEPTANCE_DB_PORTS, ACCEPTANCE_MARKER, ACCEPTANCE_SENTINEL, ACCEPTANCE_USER } from './constants.js';

export function loadAcceptanceDatabaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const file = env.DATABASE_URL_FILE;
  const source = env.DATABASE_URL ?? (file ? readFileSync(file, 'utf8').trim() : '');
  if (!source) throw new Error('Acceptance DATABASE_URL is required.');
  return source;
}

export function assertAcceptanceEnvironment(env: NodeJS.ProcessEnv = process.env) {
  if (env.UI_ACCEPTANCE_SENTINEL !== ACCEPTANCE_SENTINEL) throw new Error('Exact Phase 3B.4 acceptance sentinel required.');
  if (env.NODE_ENV === 'production') throw new Error('Acceptance refuses NODE_ENV=production.');
  if (Number(env.PORT) !== ACCEPTANCE_API_PORT) throw new Error(`Acceptance API must use port ${ACCEPTANCE_API_PORT}.`);
  if (env.ALLOW_LIVE_TRADING !== 'false' || env.ALLOW_TRADING_ENABLED_ON_START !== 'false') throw new Error('Live/trading startup flags must be explicitly false.');
  if (env.LIVE_WRITE_DEPLOYMENT_ROLE !== 'OBSERVATION_ONLY') throw new Error('Acceptance requires OBSERVATION_ONLY deployment role.');
  const inert = 'ACCEPTANCE_NO_CREDENTIAL';
  if (env.ALPACA_API_KEY !== inert || env.ALPACA_API_SECRET !== inert || env.MASSIVE_API_KEY !== inert || env.TIINGO_API_TOKEN) throw new Error('Acceptance requires exact inert provider credential sentinels.');
  const url = new URL(loadAcceptanceDatabaseUrl(env));
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('Acceptance requires PostgreSQL.');
  if (url.pathname !== `/${ACCEPTANCE_DATABASE}` || decodeURIComponent(url.username) !== ACCEPTANCE_USER) throw new Error('Acceptance database name and user identity mismatch.');
  if (!ACCEPTANCE_DB_HOSTS.has(url.hostname) || !ACCEPTANCE_DB_PORTS.has(url.port || '5432')) throw new Error('Acceptance database host/port identity rejected.');
  return url;
}

export async function assertDatabaseIdentity(client: Pick<Client, 'query'>) {
  const result = await client.query<{ database: string; user_name: string; marker: string | null }>(
    `SELECT current_database() database, current_user user_name,
      (SELECT marker FROM ui_acceptance_environment WHERE singleton = true) marker`,
  );
  const row = result.rows[0];
  if (!row || row.database !== ACCEPTANCE_DATABASE || row.user_name !== ACCEPTANCE_USER || row.marker !== ACCEPTANCE_MARKER) throw new Error('Server-side acceptance database identity verification failed.');
}

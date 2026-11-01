import 'dotenv/config';
import { Client } from 'pg';
import { assessDatabaseSecurity, type SecurityReadinessMode } from '../src/services/database-security-readiness.service.js';

// Read-only. Usage: tsx scripts/check-database-security.ts [--mode=development|broker-enabled] [--runtime-role=ai_trader_app]
// Connect as the role to be assessed (the default), or as an administrator with --runtime-role naming it.
// Exit 0 when startup is allowed in the chosen mode, 1 when it is not, 2 when the check itself could not run.
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const mode: SecurityReadinessMode = arg('mode') === 'broker-enabled' ? 'BROKER_ENABLED' : 'DEVELOPMENT_OBSERVATION';
const url = process.env.SECURITY_PREFLIGHT_DATABASE_URL ?? process.env.DATABASE_URL;

async function main() {
  if (!url) throw new Error('DATABASE_URL or SECURITY_PREFLIGHT_DATABASE_URL is required.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const runtimeRole = arg('runtime-role');
    const report = await assessDatabaseSecurity(async (sql, params) => (await client.query(sql, params)).rows, { mode, ...(runtimeRole ? { runtimeRole } : {}) });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.startupAllowed ? 0 : 1;
  } finally { await client.end(); }
}
main().catch(error => { console.error(`Security preflight could not run: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });

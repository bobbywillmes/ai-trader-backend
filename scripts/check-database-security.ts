import 'dotenv/config';
import { Client } from 'pg';
import { assessDatabaseSecurity, type AssessmentOptions } from '../src/services/database-security-readiness.service.js';
import { DEFAULT_RUNTIME_ROLE, describeConfiguredConnection, parsePreflightArgs, PREFLIGHT_USAGE } from '../src/services/database-security-cli.js';

// Read-only. An explicit mode is required; see PREFLIGHT_USAGE.
//   --mode broker-enabled           runs over DATABASE_URL (the backend's own connection) and requires that connection to be
//                                   the restricted runtime identity; no alternate URL can authorize it.
//   --mode development-observation  reports outstanding hardening over DATABASE_URL; never blocks.
//   --mode admin-diagnostic         an administrator inspects --runtime-role; diagnostic only, never authorizes broker readiness.
// Exit 0: allowed in the chosen mode. 1: findings forbid it. 2: the check could not run. 64: invalid arguments.
// Credentials and connection strings are never printed.
const parsed = parsePreflightArgs(process.argv.slice(2), process.env);
if (!parsed.ok) {
  for (const error of parsed.errors) console.error(`Invalid arguments: ${error}`);
  console.error(PREFLIGHT_USAGE);
  process.exit(64);
}

async function main() {
  if (!parsed.ok) return;
  const diagnostic = parsed.mode === 'ADMIN_DIAGNOSTIC';
  const url = diagnostic ? (process.env.SECURITY_PREFLIGHT_DATABASE_URL ?? process.env.DATABASE_URL) : process.env.DATABASE_URL;
  if (!url) throw new Error(diagnostic ? 'DATABASE_URL or SECURITY_PREFLIGHT_DATABASE_URL is required.' : 'DATABASE_URL is required.');
  const configured = describeConfiguredConnection(url);
  if (configured.unsupportedSchema !== null) {
    // The backend's adapter ignores ?schema=, so assessing that schema would authorize a boundary it does not use.
    console.error(`Invalid configuration: DATABASE_URL requests schema "${configured.unsupportedSchema}", but the backend always runs in "${configured.schema}". Remove the schema parameter.`);
    process.exit(64);
  }
  const options: AssessmentOptions = parsed.mode === 'BROKER_ENABLED'
    ? { mode: parsed.mode, expected: { role: parsed.runtimeRole ?? DEFAULT_RUNTIME_ROLE, database: configured.database, schema: configured.schema } }
    : diagnostic ? { mode: parsed.mode, inspectRole: parsed.runtimeRole! } : { mode: parsed.mode };
  if (diagnostic) console.error('DIAGNOSTIC ONLY: this administrator inspection can never authorize broker-enabled readiness.');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const report = await assessDatabaseSecurity(async (sql, params) => (await client.query(sql, params)).rows, options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = diagnostic ? (report.ready ? 0 : 1) : report.startupAllowed ? 0 : 1;
  } finally { await client.end(); }
}
main().catch(error => { console.error(`Security preflight could not run: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });

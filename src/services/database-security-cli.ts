// Strict command-line parsing for scripts/check-database-security.ts (Phase 4A.2C3B.1 correction).
//
// The CLI must never downgrade a broker-enabled request: a misspelled mode, a malformed option, a missing
// value or a duplicate is an error, never a fallback to observation. A mode is always required.

import type { SecurityReadinessMode } from './database-security-readiness.service.js';

export const PREFLIGHT_MODES: Readonly<Record<string, SecurityReadinessMode>> = {
  'broker-enabled': 'BROKER_ENABLED',
  'development-observation': 'DEVELOPMENT_OBSERVATION',
  'admin-diagnostic': 'ADMIN_DIAGNOSTIC',
};

export const PREFLIGHT_USAGE = [
  'Usage: tsx scripts/check-database-security.ts --mode <mode> [--runtime-role <role>]',
  '  --mode broker-enabled             Fail-closed readiness. Runs over DATABASE_URL, the backend\'s own connection, and',
  '                                    requires that connection to be the restricted runtime identity (default ai_trader_app).',
  '  --mode development-observation    Reports outstanding hardening over DATABASE_URL; always exits 0 when it could run.',
  '  --mode admin-diagnostic           Diagnostic only: an administrator inspects --runtime-role (required). Never authorizes',
  '                                    broker-enabled readiness. May use SECURITY_PREFLIGHT_DATABASE_URL.',
  '  --runtime-role <role>             broker-enabled: the expected runtime identity. admin-diagnostic: the role to inspect.',
  'Both "--option value" and "--option=value" are accepted.',
].join('\n');

export type PreflightArgs =
  | { ok: true; mode: SecurityReadinessMode; runtimeRole: string | null }
  | { ok: false; errors: string[] };

const KNOWN = new Set(['mode', 'runtime-role']);
const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function parsePreflightArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): PreflightArgs {
  const errors: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith('--')) { errors.push(`Unexpected argument "${token}".`); continue; }
    const equals = token.indexOf('=');
    const name = token.slice(2, equals === -1 ? undefined : equals);
    if (!KNOWN.has(name)) { errors.push(`Unrecognized option "${token.split('=')[0]}".`); continue; }
    let value: string | undefined;
    if (equals !== -1) value = token.slice(equals + 1);
    else if (index + 1 < argv.length && !argv[index + 1]!.startsWith('--')) value = argv[++index];
    if (value === undefined || value === '') { errors.push(`Option --${name} requires a value.`); continue; }
    if (values.has(name)) { errors.push(`Option --${name} was given more than once.`); continue; }
    values.set(name, value);
  }

  const rawMode = values.get('mode');
  let mode: SecurityReadinessMode | null = null;
  if (rawMode === undefined) { if (!errors.some(error => error.includes('--mode'))) errors.push('Option --mode is required (broker-enabled, development-observation or admin-diagnostic).'); }
  else if (Object.hasOwn(PREFLIGHT_MODES, rawMode)) mode = PREFLIGHT_MODES[rawMode]!;
  else errors.push(`Unknown mode "${rawMode}"; expected broker-enabled, development-observation or admin-diagnostic.`);

  const runtimeRole = values.get('runtime-role') ?? null;
  if (runtimeRole !== null && !ROLE_NAME.test(runtimeRole)) errors.push(`Invalid --runtime-role "${runtimeRole}".`);
  if (mode === 'ADMIN_DIAGNOSTIC' && runtimeRole === null) errors.push('--mode admin-diagnostic requires --runtime-role.');
  if (mode === 'DEVELOPMENT_OBSERVATION' && runtimeRole !== null) errors.push('--runtime-role is only valid with broker-enabled or admin-diagnostic.');
  // The override exists for diagnostics only; it may never decide broker-enabled readiness or observation.
  if (mode && mode !== 'ADMIN_DIAGNOSTIC' && env.SECURITY_PREFLIGHT_DATABASE_URL) errors.push('SECURITY_PREFLIGHT_DATABASE_URL is set; it is permitted only with --mode admin-diagnostic. Unset it so the preflight runs over DATABASE_URL.');

  return errors.length || mode === null ? { ok: false, errors } : { ok: true, mode, runtimeRole };
}

/** The runtime identity the backend is expected to connect as; broker-enabled readiness binds to it. */
export const DEFAULT_RUNTIME_ROLE = 'ai_trader_app';

/**
 * Non-secret facts about the connection the backend uses, read from DATABASE_URL without ever keeping
 * the password: the login role, database name and schema the application is configured for.
 */
export function describeConfiguredConnection(connectionString: string): { user: string | null; database: string | null; schema: string } {
  const url = new URL(connectionString);
  return {
    user: url.username ? decodeURIComponent(url.username) : null,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || null,
    schema: url.searchParams.get('schema') ?? 'public',
  };
}

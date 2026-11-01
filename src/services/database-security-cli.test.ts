import { describe, expect, it } from 'vitest';
import { describeConfiguredConnection, parsePreflightArgs } from './database-security-cli.js';

const ok = (argv: string[], env: Record<string, string> = {}) => parsePreflightArgs(argv, env);
const errors = (argv: string[], env: Record<string, string> = {}) => { const result = ok(argv, env); if (result.ok) throw new Error(`expected a failure for ${JSON.stringify(argv)}`); return result.errors.join(' | '); };

describe('security preflight argument parsing', () => {
  it.each([
    [['--mode=broker-enabled'], 'BROKER_ENABLED', null],
    [['--mode', 'broker-enabled'], 'BROKER_ENABLED', null],
    [['--mode=broker-enabled', '--runtime-role=ai_trader_app'], 'BROKER_ENABLED', 'ai_trader_app'],
    [['--runtime-role', 'ai_trader_app', '--mode', 'broker-enabled'], 'BROKER_ENABLED', 'ai_trader_app'],
    [['--mode=development-observation'], 'DEVELOPMENT_OBSERVATION', null],
    [['--mode', 'development-observation'], 'DEVELOPMENT_OBSERVATION', null],
    [['--mode=admin-diagnostic', '--runtime-role=ai_trader_app'], 'ADMIN_DIAGNOSTIC', 'ai_trader_app'],
  ] as const)('accepts %j', (argv, mode, runtimeRole) => {
    expect(ok([...argv])).toEqual({ ok: true, mode, runtimeRole });
  });

  it.each([
    [['--mode=broker_enabled'], /Unknown mode "broker_enabled"/],
    [['--mode=Broker-Enabled'], /Unknown mode/],
    [['--mode=development'], /Unknown mode/],
    [['--mode=broker-enabled', '--bogus'], /Unrecognized option "--bogus"/],
    [['--mod=broker-enabled'], /Unrecognized option "--mod"/],
    [['--mode'], /--mode requires a value/],
    [['--mode='], /--mode requires a value/],
    [['--mode', '--runtime-role', 'ai_trader_app'], /--mode requires a value/],
    [['--mode=broker-enabled', '--runtime-role'], /--runtime-role requires a value/],
    [['broker-enabled'], /Unexpected argument "broker-enabled"/],
    [['--mode=broker-enabled', 'extra'], /Unexpected argument "extra"/],
    [['--mode=broker-enabled', '--mode=development-observation'], /more than once/],
    [['--mode=broker-enabled', '--mode', 'broker-enabled'], /more than once/],
    [[], /--mode is required/],
    [['--runtime-role=ai_trader_app'], /--mode is required/],
    [['--mode=admin-diagnostic'], /requires --runtime-role/],
    [['--mode=development-observation', '--runtime-role=ai_trader_app'], /only valid with broker-enabled or admin-diagnostic/],
    [['--mode=broker-enabled', '--runtime-role=bad role;'], /Invalid --runtime-role/],
  ] as const)('rejects %j', (argv, message) => {
    expect(errors([...argv])).toMatch(message);
  });

  it('never lets the alternate URL variable decide broker-enabled or observation runs', () => {
    const env = { SECURITY_PREFLIGHT_DATABASE_URL: 'postgresql://x' };
    expect(errors(['--mode=broker-enabled'], env)).toMatch(/SECURITY_PREFLIGHT_DATABASE_URL/);
    expect(errors(['--mode=development-observation'], env)).toMatch(/SECURITY_PREFLIGHT_DATABASE_URL/);
    expect(ok(['--mode=admin-diagnostic', '--runtime-role=ai_trader_app'], env)).toMatchObject({ ok: true });
  });

  it('reads only non-secret facts from the configured connection', () => {
    const configured = describeConfiguredConnection('postgresql://ai_trader_app:s3cret%21@db.internal:5432/ai_trader?schema=trading');
    expect(configured).toEqual({ user: 'ai_trader_app', database: 'ai_trader', schema: 'trading' });
    expect(JSON.stringify(configured)).not.toContain('s3cret');
    expect(describeConfiguredConnection('postgresql://u:p@h/db')).toEqual({ user: 'u', database: 'db', schema: 'public' });
  });
});

import { describe, expect, it } from 'vitest';
import { assertPaperBrokerWritePreflightContext, parsePaperBrokerWritePreflightArgs } from './paper-broker-write-preflight.js';

describe('PAPER broker-write preflight', () => {
  it('keeps empty invocation explicitly informational', () => {
    expect(parsePaperBrokerWritePreflightArgs([])).toMatchObject({ mode: 'inspect', expectedTradingAccountId: null });
  });

  it.each([
    [['--mod', 'production']], [['--mode']], [['--mode=production']], [['--mode', 'invalid']],
    [['--mode', 'production', '--mode', 'inspect']], [['--mode', 'production']],
  ])('rejects malformed or incomplete input: %j', (args) => {
    expect(() => parsePaperBrokerWritePreflightArgs(args)).toThrow();
  });

  it('distinguishes valid informational mode from a complete GO-capable mode', () => {
    const args = parsePaperBrokerWritePreflightArgs(['--mode', 'production', '--expected-trading-account-id', '7',
      '--expected-broker-account-number', 'PA1', '--expected-database', 'ai_trader', '--expected-database-host', '10.0.0.8',
      '--expected-image-revision', 'abc123', '--expected-database-port', '5432', '--expected-database-user', 'ai_trader_app']);
    const target = { database: 'ai_trader', host: '10.0.0.8', port: 5432, user: 'ai_trader_app' };
    expect(args).toMatchObject({ mode: 'production', expectedTradingAccountId: 7 });
    expect(() => assertPaperBrokerWritePreflightContext(args, 'development', 'abc123', target)).toThrow('NODE_ENV=production');
    expect(() => assertPaperBrokerWritePreflightContext(args, 'production', 'abc123', { ...target, host: '10.0.0.9' })).toThrow('server host');
    expect(() => assertPaperBrokerWritePreflightContext(args, 'production', 'other', target)).toThrow('image revision');
    expect(() => assertPaperBrokerWritePreflightContext(args, 'production', 'abc123', target)).not.toThrow();
  });
});

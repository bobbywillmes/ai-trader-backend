import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertPaperBrokerWritePreflightContext, parsePaperBrokerWritePreflightArgs,
  readEmbeddedImageRevision } from './paper-broker-write-preflight.js';

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

  it('reads revision evidence from the build-owned file rather than runtime environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-preflight-'));
    const path = join(directory, '.image-revision');
    try {
      writeFileSync(path, 'reviewed-sha\n');
      process.env.IMAGE_REVISION = 'env-file-override';
      expect(readEmbeddedImageRevision(path)).toBe('reviewed-sha');
    } finally {
      delete process.env.IMAGE_REVISION;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

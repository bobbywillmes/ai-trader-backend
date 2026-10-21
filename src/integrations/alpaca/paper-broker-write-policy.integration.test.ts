import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), findMany: vi.fn(), fetch: vi.fn() }));
vi.mock('../../services/alpaca-config-resolver.service.js', () => ({ resolveAlpacaConfigForTradingAccount: mocks.resolve }));
vi.mock('../../db/prisma.js', () => ({ prisma: { tradingAccount: { findMany: mocks.findMany } } }));

const key = 'validation-policy-key';
const fingerprint = `sha256:${crypto.createHash('sha256').update(key).digest('hex')}`;
const metadata = { operation: 'pending_order_submission', endpoint: 'POST /v2/orders', method: 'POST',
  requestClass: 'critical_write', operationClass: 'ENTRY_WRITE', deferDuringRateLimit: false } as const;

describe('shared Alpaca client with real PAPER authority policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.resolve.mockResolvedValue({ tradingAccountId: 7, environment: 'PAPER', baseUrl: 'https://paper-api.alpaca.markets',
      apiKey: key, apiSecret: 'not-logged', source: 'trading_account_credential', credentialId: 1,
      brokerAccountId: 'validation-paper', keyFingerprint: fingerprint });
    mocks.findMany.mockResolvedValue([{ id: 7 }]);
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

  it('blocks observation-only PAPER mutation before fetch', async () => {
    vi.stubEnv('PAPER_BROKER_WRITE_DEPLOYMENT_ROLE', 'OBSERVATION_ONLY');
    vi.stubEnv('PAPER_BROKER_WRITE_AUTHORIZATIONS', '[]');
    vi.stubEnv('PAPER_BROKER_WRITE_OWNERSHIP', JSON.stringify([
      { tradingAccountId: 7, role: 'OBSERVER', expectedBrokerAccountId: 'validation-paper' },
    ]));
    const { alpacaRequestForAccount } = await import('./client.js');
    await expect(alpacaRequestForAccount(7, '/v2/orders', { method: 'POST', body: { symbol: 'SPY' }, metadata }))
      .rejects.toMatchObject({ classification: 'NOT_SENT_BLOCKED' });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('allows the separately authorized validation identity through the same boundary', async () => {
    vi.stubEnv('PAPER_BROKER_WRITE_DEPLOYMENT_ROLE', 'PAPER_EXECUTOR');
    vi.stubEnv('PAPER_BROKER_WRITE_AUTHORIZATIONS', JSON.stringify([{ brokerAccountId: 'validation-paper', keyFingerprint: fingerprint }]));
    vi.stubEnv('PAPER_BROKER_WRITE_OWNERSHIP', JSON.stringify([
      { tradingAccountId: 6, role: 'OBSERVER', expectedBrokerAccountId: 'bobby-paper' },
      { tradingAccountId: 7, role: 'EXECUTOR', expectedBrokerAccountId: 'validation-paper' },
    ]));
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ id: 'order-1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const { alpacaRequestForAccount } = await import('./client.js');
    await expect(alpacaRequestForAccount(7, '/v2/orders', { method: 'POST', body: { symbol: 'SPY' }, metadata })).resolves.toEqual({ id: 'order-1' });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Prisma, type ExternalSignalSource } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  externalSignalSource: { findUnique: vi.fn() },
  strategySignalBinding: { findUnique: vi.fn() }, security: { findUnique: vi.fn() },
  signal: { findUnique: vi.fn(), create: vi.fn() }, signalDelivery: { create: vi.fn() },
  systemEvent: { create: vi.fn() }, transaction: vi.fn(),
}));
vi.mock('../db/prisma.js', () => ({ prisma: { ...mocks, $transaction: mocks.transaction } }));
import { authenticateExternalSignal, ingestExternalSignal, type SignalRequestEvidence } from './external-signal-ingestion.service.js';
import { hashWebhookToken } from './external-signal-config.service.js';
import { canonicalJson, MAX_SIGNAL_BODY_BYTES } from './external-signal-normalization.js';

const token = 'a'.repeat(43);
const source: ExternalSignalSource = { id: 1, name: 'Test', provider: 'GENERIC_WEBHOOK', enabled: true,
  authMethod: 'URL_TOKEN', webhookTokenHash: hashWebhookToken(token), createdAt: new Date(), updatedAt: new Date() };
const binding = { id: 2, signalSourceId: 1, strategyId: 3, externalStrategyKey: 'mean_reversion', expectedRevision: 'r1', enabled: true };
const envelope = { schemaVersion: 1, externalStrategyKey: 'mean_reversion', strategyRevision: 'r1',
  event: 'ENTRY_LONG', symbol: 'QQQ', timeframe: '15m', signalTime: '2026-09-07T15:45:00Z',
  barTime: '2026-09-07T15:30:00Z', eventKey: 'event-1', metadata: { triggerPrice: 600.25, rsi: 28.4 } };

function evidence(value: unknown = envelope): SignalRequestEvidence {
  const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { requestId: 'server-generated', receivedAt: new Date('2026-09-07T16:00:00Z'),
    contentType: 'application/json', bodySizeBytes: body.length, body,
    rawPayloadHash: createHash('sha256').update(body).digest('hex'),
    tooLarge: body.length > MAX_SIGNAL_BODY_BYTES, validContentType: true };
}

describe('external signal ingestion evidence boundary', () => {
  let signals: Array<Record<string, unknown>>;
  let deliveries: Array<Record<string, unknown>>;
  beforeEach(() => {
    vi.clearAllMocks(); signals = []; deliveries = [];
    mocks.transaction.mockImplementation(async fn => fn(mocks));
    mocks.externalSignalSource.findUnique.mockResolvedValue(source);
    mocks.strategySignalBinding.findUnique.mockResolvedValue(binding);
    mocks.security.findUnique.mockResolvedValue({ id: 4, symbol: 'QQQ' });
    mocks.signal.findUnique.mockImplementation(async () => signals[0] ?? null);
    mocks.signal.create.mockImplementation(async ({ data }) => {
      const row = { id: signals.length + 10, ...data }; signals.push(row); return row;
    });
    mocks.signalDelivery.create.mockImplementation(async ({ data }) => {
      const row = { id: deliveries.length + 20, ...data }; deliveries.push(row); return row;
    });
  });
  const ingest = (value: unknown = envelope) => ingestExternalSignal(source, token, evidence(value));

  it.each(['ENTRY_LONG', 'EXIT_LONG'])('records %s without any trading dependency or authority', async event => {
    const result = await ingest({ ...envelope, event, metadata: { tradingAccountId: 99, quantity: 1000000, bypassRisk: true } });
    expect(result?.status).toBe('NORMALIZED');
    expect(signals).toHaveLength(1); expect(deliveries).toHaveLength(1);
    expect(result?.signalId).toBe(signals[0]!.id);
    expect(signals[0]).not.toHaveProperty('tradingAccountId');
    expect(signals[0]).not.toHaveProperty('quantity');
    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.systemEvent.create).not.toHaveBeenCalled();
  });
  it('deduplicates normalized content and preserves historical rows byte-for-byte', async () => {
    await ingest({ ...envelope, timeframe: '1h' });
    const before = canonicalJson(signals);
    const retry = await ingest({ ...envelope, symbol: 'qqq', timeframe: '60m',
      signalTime: '2026-09-07T11:45:00-04:00', metadata: { rsi: 28.4, triggerPrice: 600.25 } });
    expect(retry?.status).toBe('DUPLICATE'); expect(retry?.signalId).toBe(signals[0]!.id);
    expect(signals).toHaveLength(1); expect(deliveries).toHaveLength(2);
    expect(canonicalJson(signals)).toBe(before);
  });
  it.each([
    { metadata: { rsi: 29 } }, { event: 'EXIT_LONG' }, { barTime: '2026-09-07T15:00:00Z' },
    { signalTime: '2026-09-07T15:46:00Z' }, { timeframe: '30m' },
  ])('rejects changed canonical content without mutating the original: %j', async change => {
    await ingest(); const before = canonicalJson(signals);
    const result = await ingest({ ...envelope, ...change });
    expect(result?.rejectionCode).toBe('EVENT_KEY_CONFLICT');
    expect(result?.signalId).toBeUndefined();
    expect(signals).toHaveLength(1); expect(canonicalJson(signals)).toBe(before);
    expect(mocks.systemEvent.create.mock.calls[0]![0].data.severity).toBe('WARNING');
  });
  it('retries a unique-constraint race in a fresh transaction', async () => {
    await ingest(); const existing = signals[0];
    mocks.signal.findUnique.mockResolvedValueOnce(null).mockResolvedValue(existing);
    mocks.signal.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '7' }));
    const result = await ingest();
    expect(result?.status).toBe('DUPLICATE'); expect(signals).toHaveLength(1);
    expect(deliveries).toHaveLength(2); expect(mocks.transaction).toHaveBeenCalledTimes(3);
  });
  it('propagates delivery persistence failure for transaction rollback', async () => {
    mocks.signalDelivery.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(ingest()).rejects.toThrow('database unavailable');
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });
  it('does not persist unknown-token requests', async () => {
    mocks.externalSignalSource.findUnique.mockResolvedValue(null);
    expect(await authenticateExternalSignal('bad')).toBeNull();
    expect(await authenticateExternalSignal('b'.repeat(43))).toBeNull();
    expect(mocks.signalDelivery.create).not.toHaveBeenCalled();
  });
  it.each([
    ['SOURCE_DISABLED', 'externalSignalSource', { ...source, enabled: false }],
    ['UNKNOWN_STRATEGY_BINDING', 'strategySignalBinding', null],
    ['STRATEGY_BINDING_DISABLED', 'strategySignalBinding', { ...binding, enabled: false }],
    ['STRATEGY_REVISION_MISMATCH', 'strategySignalBinding', { ...binding, expectedRevision: 'r2' }],
    ['UNKNOWN_SYMBOL', 'security', null],
  ] as const)('rejects %s', async (code, delegate, value) => {
    mocks[delegate].findUnique.mockResolvedValue(value);
    expect((await ingest())?.rejectionCode).toBe(code); expect(signals).toHaveLength(0);
  });
  it.each([
    ['INVALID_EVENT', { event: 'ENTRY_SHORT' }], ['INVALID_TIMEFRAME', { timeframe: '60' }],
    ['INVALID_TIMEFRAME', { timeframe: '1M' }], ['INVALID_TIMEFRAME', { timeframe: 'toString' }],
    ['INVALID_TIMESTAMP', { signalTime: 'yesterday' }],
    ['INVALID_TIMESTAMP', { signalTime: '2026-02-30T15:45:00Z' }],
    ['INVALID_TIMESTAMP', { signalTime: '2026-09-07T15:45:00' }],
    ['INVALID_TIMESTAMP', { signalTime: '2026-09-07T15:45:00.1234Z' }],
    ['INVALID_TIMESTAMP', { signalTime: '2027-09-07T15:45:00Z' }],
    ['INVALID_TIMESTAMP', { barTime: '2026-09-07T16:00:00Z' }],
    ['UNSUPPORTED_SCHEMA_VERSION', { schemaVersion: 2 }],
    ['INVALID_ENVELOPE', { tradingAccountId: 1 }],
    ['INVALID_ENVELOPE', { eventKey: '' }],
    ['INVALID_ENVELOPE', { metadata: { note: 'x'.repeat(4097) } }],
  ])('validates %s for %j', async (code, change) => {
    expect((await ingest({ ...envelope, ...change as object }))?.rejectionCode).toBe(code);
    expect(signals).toHaveLength(0);
  });
  it('accepts delayed events without staleness rejection', async () => {
    expect((await ingest({ ...envelope, signalTime: '2000-01-01T00:00:00Z', barTime: '2000-01-01T00:00:00Z' }))?.status).toBe('NORMALIZED');
  });
  it.each(['{bad json', '{"token":"' + token + '"', 'x'.repeat(MAX_SIGNAL_BODY_BYTES + 1)])('omits malformed or oversized body text', async body => {
    const result = await ingest(body);
    expect(result?.status).toBe('REJECTED'); expect(JSON.stringify(deliveries)).not.toContain(token);
    expect(result?.rawPayloadHash).toBe(createHash('sha256').update(body).digest('hex'));
  });
  it('rejects non-JSON content types', async () => {
    const result = await ingestExternalSignal(source, token, { ...evidence(), validContentType: false });
    expect(result?.rejectionCode).toBe('INVALID_CONTENT_TYPE');
  });
  it('redacts nested credentials, credential values and credential key names from evidence', async () => {
    const result = await ingest({ ...envelope, metadata: { password: 'sensitive-password', nested: [
      { api_key: 'sensitive-key', note: token, [token]: 'value', auth: `Bearer secret-access` },
    ] } });
    expect(result?.rejectionCode).toBe('INVALID_ENVELOPE');
    for (const secret of [token, 'sensitive-password', 'sensitive-key', 'secret-access']) {
      expect(JSON.stringify(deliveries)).not.toContain(secret);
    }
    expect(signals).toHaveLength(0);
  });
  it('bounds nesting before recursive schema validation', async () => {
    let metadata: object = {}; for (let i = 0; i < 100; i++) metadata = { nested: metadata };
    expect((await ingest({ ...envelope, metadata }))?.rejectionCode).toBe('INVALID_ENVELOPE');
  });
  it('configuration changes affect new deliveries without rewriting historical Signals', async () => {
    await ingest(); const before = canonicalJson(signals);
    mocks.strategySignalBinding.findUnique.mockResolvedValue({ ...binding, expectedRevision: 'r2' });
    expect((await ingest())?.rejectionCode).toBe('STRATEGY_REVISION_MISMATCH');
    mocks.externalSignalSource.findUnique.mockResolvedValue({ ...source, enabled: false });
    expect((await ingest())?.rejectionCode).toBe('SOURCE_DISABLED');
    expect(canonicalJson(signals)).toBe(before);
  });
  it('contains no evidence mutations or trading imports', () => {
    for (const file of ['external-signal-config.service.ts', 'external-signal-ingestion.service.ts', 'external-signal-read.service.ts']) {
      const code = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(code).not.toMatch(/\.(?:signal|signalDelivery)\.(?:update|upsert|delete)/);
      expect(code).not.toMatch(/(?:entryDecision|orderIntent|brokerOrder|trackedPosition|tradingAccountSubscription)\./);
      expect(code).not.toMatch(/from ['"].*(?:signal-entry|place-order|exit-evaluator|close-position|risk-gate|integrations|workers)/);
    }
  });
});

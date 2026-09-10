import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  externalSignalSource: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  strategySignalBinding: { create: vi.fn(), update: vi.fn() },
  strategy: { findUnique: vi.fn() }, systemEvent: { create: vi.fn() },
}));
vi.mock('../db/prisma.js', () => ({ prisma: { ...mocks, $transaction: (fn: (db: typeof mocks) => unknown) => fn(mocks) } }));
vi.mock('./trading-credential-crypto.service.js', () => ({ encryptSecret: (value: string) => `encrypted:${value}`, decryptSecret: (value: string) => value.slice(10) }));
import { getExternalSignalWebhook, createExternalSignalSource, regenerateExternalSignalWebhook, bindingRevisionInclude, hashWebhookKey, createStrategySignalBinding, updateStrategySignalBinding } from './external-signal-config.service.js';
import { updateStrategySignalBindingSchema, updateExternalSignalSourceSchema } from '../validators/external-signal.schema.js';

describe('external signal configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.externalSignalSource.create.mockResolvedValue({ id: 1, provider: 'GENERIC_WEBHOOK', enabled: true });
    mocks.externalSignalSource.update.mockResolvedValue({ id: 1 });
    mocks.externalSignalSource.findUnique.mockResolvedValue({ id: 1 });
    mocks.strategy.findUnique.mockResolvedValue({ id: 2 });
    mocks.strategySignalBinding.create.mockResolvedValue({ id: 3 });
    mocks.strategySignalBinding.update.mockResolvedValue({ id: 3 });
  });
  it('creates encrypted 256-bit stable keys retrievable later without exposing credentials in ordinary DTOs', async () => {
    const result = await createExternalSignalSource({ name: 'Test', provider: 'GENERIC_WEBHOOK' }, -1);
    const call = mocks.externalSignalSource.create.mock.calls[0]![0];
    const key = call.data.webhookKeyCiphertext.slice(10);
    expect(key).toMatch(/^[\w-]{43}$/);
    expect(call.data.webhookKeyHash).toBe(hashWebhookKey(key));
    mocks.externalSignalSource.findUnique.mockResolvedValue({ id: 1, ...call.data });
    expect(await getExternalSignalWebhook(1, -1)).toEqual({ webhookKey: key });
    expect(await getExternalSignalWebhook(1, -1)).toEqual({ webhookKey: key });
    expect(call.select).not.toHaveProperty('webhookKeyHash');
    expect(call.select).not.toHaveProperty('webhookKeyCiphertext');
    expect(result).not.toHaveProperty('webhookKey');
    expect(JSON.stringify(mocks.systemEvent.create.mock.calls)).not.toContain(key);
  });
  it('regenerates a fresh key without auditing or returning capability material', async () => {
    await regenerateExternalSignalWebhook(1, -1);
    const result = await regenerateExternalSignalWebhook(1, -1);
    const first = mocks.externalSignalSource.update.mock.calls[0]![0].data;
    const second = mocks.externalSignalSource.update.mock.calls[1]![0].data;
    expect(first.webhookKeyHash).not.toBe(second.webhookKeyHash);
    expect(result).not.toHaveProperty('webhookKey');
    expect(JSON.stringify(mocks.systemEvent.create.mock.calls)).not.toContain(second.webhookKeyCiphertext.slice(10));
  });
  it('requires existing source and strategy', async () => {
    mocks.strategy.findUnique.mockResolvedValue(null);
    await expect(createStrategySignalBinding({ signalSourceId: 1, strategyId: 2,
      externalStrategyKey: 'test' }, -1)).rejects.toThrow('already exist');
    expect(mocks.strategySignalBinding.create).not.toHaveBeenCalled();
  });
  it('only permits prospective binding updates and audits the changed fields', async () => {
    for (const field of ['strategyId', 'signalSourceId', 'externalStrategyKey']) {
      expect(updateStrategySignalBindingSchema.safeParse({ [field]: 4, enabled: false }).success).toBe(false);
    }
    expect(updateExternalSignalSourceSchema.safeParse({ webhookKeyHash: 'secret' }).success).toBe(false);
    await updateStrategySignalBinding(3, { enabled: false }, -1);
    expect(mocks.strategySignalBinding.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { enabled: false }, include: bindingRevisionInclude });
    expect(mocks.systemEvent.create).toHaveBeenCalledOnce();
  });
});

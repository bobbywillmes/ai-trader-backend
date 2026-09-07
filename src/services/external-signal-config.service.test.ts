import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  externalSignalSource: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  strategySignalBinding: { create: vi.fn(), update: vi.fn() },
  strategy: { findUnique: vi.fn() }, systemEvent: { create: vi.fn() },
}));
vi.mock('../db/prisma.js', () => ({ prisma: { ...mocks, $transaction: (fn: (db: typeof mocks) => unknown) => fn(mocks) } }));
import { createExternalSignalSource, rotateExternalSignalToken, hashWebhookToken, createStrategySignalBinding, updateStrategySignalBinding } from './external-signal-config.service.js';
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
  it('returns a 256-bit token once and stores only its hash; ordinary selections exclude credentials', async () => {
    const result = await createExternalSignalSource({ name: 'Test', provider: 'GENERIC_WEBHOOK' }, -1);
    expect(result.token).toMatch(/^[\w-]{43}$/);
    const call = mocks.externalSignalSource.create.mock.calls[0]![0];
    expect(call.data.webhookTokenHash).toBe(hashWebhookToken(result.token));
    expect(call.select).not.toHaveProperty('webhookTokenHash');
    expect(JSON.stringify(mocks.systemEvent.create.mock.calls)).not.toContain(result.token);
    expect(JSON.stringify(mocks.systemEvent.create.mock.calls)).not.toContain(call.data.webhookTokenHash);
    expect(mocks.systemEvent.create.mock.calls[0]![0].data.actorUserId).toBeNull();
    expect(result.source).not.toHaveProperty('webhookTokenHash');
  });
  it('rotates to a fresh credential and audits without including credentials', async () => {
    const first = await rotateExternalSignalToken(1, -1);
    const second = await rotateExternalSignalToken(1, -1);
    expect(first.token).not.toBe(second.token);
    expect(mocks.externalSignalSource.update.mock.calls[1]![0].data.webhookTokenHash).toBe(hashWebhookToken(second.token));
    expect(JSON.stringify(mocks.systemEvent.create.mock.calls)).not.toContain(second.token);
  });
  it('requires existing source and strategy', async () => {
    mocks.strategy.findUnique.mockResolvedValue(null);
    await expect(createStrategySignalBinding({ signalSourceId: 1, strategyId: 2,
      externalStrategyKey: 'test', expectedRevision: 'r1' }, -1)).rejects.toThrow('already exist');
    expect(mocks.strategySignalBinding.create).not.toHaveBeenCalled();
  });
  it('only permits prospective binding updates and audits the changed fields', async () => {
    for (const field of ['strategyId', 'signalSourceId', 'externalStrategyKey']) {
      expect(updateStrategySignalBindingSchema.safeParse({ [field]: 4, enabled: false }).success).toBe(false);
    }
    expect(updateExternalSignalSourceSchema.safeParse({ webhookTokenHash: 'secret' }).success).toBe(false);
    await updateStrategySignalBinding(3, { expectedRevision: 'r2', enabled: false }, -1);
    expect(mocks.strategySignalBinding.update).toHaveBeenCalledWith({ where: { id: 3 }, data: { expectedRevision: 'r2', enabled: false } });
    expect(mocks.systemEvent.create).toHaveBeenCalledOnce();
  });
});

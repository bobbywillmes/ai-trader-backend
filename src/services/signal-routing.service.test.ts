import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
const mocks = vi.hoisted(() => ({
  $queryRaw: vi.fn(), signal: { findUnique: vi.fn() },
  signalRoutingRun: { findUnique: vi.fn(), create: vi.fn() },
  tradingAccountSubscription: { findMany: vi.fn() },
}));
vi.mock('../db/prisma.js', () => ({ prisma: mocks }));
import { routeSignalInTransaction } from './signal-routing.service.js';
const target = { id: 4, tradingAccountId: 2, subscriptionId: 3,
  tradingAccount: { displayName: 'Paper' }, subscription: { key: 'conservative', name: 'Conservative',
    strategy: { id: 1, key: 'momentum', name: 'Momentum' }, security: { id: 5, symbol: 'RSP' } } };

describe('signal routing capability boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.signalRoutingRun.findUnique.mockResolvedValue(null);
    mocks.signalRoutingRun.create.mockImplementation(async ({ data }) => data);
    mocks.tradingAccountSubscription.findMany.mockResolvedValue([target]);
  });
  const route = (authorityMode: string | null) => {
    mocks.signal.findUnique.mockResolvedValue({ id: 1, strategyId: 1, securityId: 5,
      strategySignalRevision: authorityMode ? { authorityMode } : null });
    return routeSignalInTransaction(1, mocks as unknown as Prisma.TransactionClient);
  };
  it.each(['EVIDENCE_ONLY', null])('stops %s without querying accounts or subscriptions', async mode => {
    expect(await route(mode)).toMatchObject({ status: 'STOPPED', authorityMode: 'EVIDENCE_ONLY', routeCount: 0, routes: { create: [] } });
    expect(mocks.tradingAccountSubscription.findMany).not.toHaveBeenCalled();
  });
  it.each(['EVALUATION_ONLY', 'TRADE_ELIGIBLE'])('only resolves identity for %s', async mode => {
    expect(await route(mode)).toMatchObject({ status: 'COMPLETED', authorityMode: mode, routeCount: 1,
      routes: { create: [{ tradingAccountId: 2, tradingAccountSubscriptionId: 4, subscriptionId: 3, targetSnapshot: { subscriptionKey: 'conservative' } }] } });
    expect(mocks.tradingAccountSubscription.findMany.mock.calls[0]![0].where).toEqual({ enabled: true, subscription: { enabled: true, strategyId: 1, securityId: 5 } });
  });
  it('returns authoritative evidence without re-reading mutable configuration', async () => {
    const original = { id: 7, routeCount: 0, routes: [] };
    mocks.signalRoutingRun.findUnique.mockResolvedValue(original);
    expect(await route('TRADE_ELIGIBLE')).toBe(original);
    expect(mocks.signal.findUnique).not.toHaveBeenCalled();
    expect(mocks.tradingAccountSubscription.findMany).not.toHaveBeenCalled();
    expect(mocks.signalRoutingRun.create).not.toHaveBeenCalled();
  });
  it('fails closed on ambiguous account configuration before persisting anything', async () => {
    mocks.tradingAccountSubscription.findMany.mockResolvedValue([target, { ...target, id: 9 }]);
    await expect(route('TRADE_ELIGIBLE')).rejects.toThrow('Ambiguous');
    expect(mocks.signalRoutingRun.create).not.toHaveBeenCalled();
  });
  it('has no broker, entry, position, exit, or evaluation dependencies or database write capabilities', () => {
    const source = readFileSync(new URL('./signal-routing.service.ts', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(imports).toEqual(['@prisma/client', '../db/prisma.js', '../errors/http-error.js']);
    const capabilities = source.match(/type RoutingDb = Pick<Prisma.TransactionClient, ([^;]+)>;/)![1];
    expect(capabilities).toBe("'$queryRaw' | 'signal' | 'signalRoutingRun' | 'tradingAccountSubscription'");
    for (const forbidden of ['orderIntent', 'brokerOrder', 'brokerActivity', 'trackedPosition', 'entryDecision', 'fetch(', 'exitEvaluator', 'placeOrder']) expect(source).not.toContain(forbidden);
  });
});

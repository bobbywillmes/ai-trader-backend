import { readFileSync } from 'node:fs';
import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/prisma.js', () => ({ prisma: {} }));
import { evaluateSignalRouteInTransaction } from './signal-evaluation.service.js';

describe('per-route evaluation evidence', () => {
  const db = { $queryRaw: vi.fn(), signalEvaluation: { findUnique: vi.fn(), create: vi.fn() },
    signalRoute: { findUnique: vi.fn() }, tradingAccountSubscription: { findUnique: vi.fn() },
    trackedPosition: { findMany: vi.fn() }, systemEvent: { create: vi.fn() } };
  let route: { id: number; evaluationVersion: number | null; tradingAccountId: number; tradingAccountSubscriptionId: number; subscriptionId: number;
    routingRun: { authorityMode: string; signal: { event: string; strategyId: number; securityId: number } } };
  let assignment: { id: number; tradingAccountId: number; subscriptionId: number; enabled: boolean; entriesEnabled: boolean; exitsEnabled: boolean;
    subscription: { strategyId: number; securityId: number; exitManagementMode: string } };
  const run = () => evaluateSignalRouteInTransaction(1, db as unknown as Prisma.TransactionClient);
  beforeEach(() => {
    vi.resetAllMocks();
    route = { id: 1, evaluationVersion: 1, tradingAccountId: 2, tradingAccountSubscriptionId: 3, subscriptionId: 4,
      routingRun: { authorityMode: 'EVALUATION_ONLY', signal: { event: 'ENTRY_LONG', strategyId: 5, securityId: 6 } } };
    assignment = { id: 3, tradingAccountId: 2, subscriptionId: 4, enabled: true, entriesEnabled: true, exitsEnabled: true,
      subscription: { strategyId: 5, securityId: 6, exitManagementMode: 'EXTERNAL_SIGNAL' } };
    db.signalRoute.findUnique.mockImplementation(async () => route);
    db.tradingAccountSubscription.findUnique.mockImplementation(async () => assignment);
    db.signalEvaluation.create.mockImplementation(async ({ data }) => ({ id: 7, ...data }));
    db.trackedPosition.findMany.mockResolvedValue([]);
  });
  it.each(['EVALUATION_ONLY', 'TRADE_ELIGIBLE'])('%s can be eligible without execution authority', async authority => {
    route.routingRun.authorityMode = authority;
    const result = await run();
    expect(result).toMatchObject({ status: 'COMPLETED', outcome: 'ELIGIBLE', prospectiveExitManagementMode: 'EXTERNAL_SIGNAL',
      intent: 'ENTRY', riskDirection: 'RISK_INCREASING', gateCount: 4,
      gates: { create: [ { sequence: 1, gateKey: 'ROUTE_TARGET', result: 'PASS' },
        { sequence: 2, gateKey: 'SUBSCRIPTION_ACTIVE', result: 'PASS' },
        { sequence: 3, gateKey: 'ALLOW_NEW_ENTRIES', result: 'PASS' },
        { sequence: 4, gateKey: 'ENTRY_APPLICABILITY', result: 'PASS' } ] } });
    expect(db.trackedPosition.findMany).not.toHaveBeenCalled();
  });
  it.each([['enabled', 'SUBSCRIPTION_INACTIVE'], ['entriesEnabled', 'NEW_ENTRIES_DISABLED']] as const)('blocks disabled %s', async (key, reason) => {
    assignment[key] = false;
    expect(await run()).toMatchObject({ status: 'COMPLETED', outcome: 'BLOCKED', reasonCode: reason });
  });
  it('preserves historical routes without evaluating current context', async () => {
    route.evaluationVersion = null;
    expect(await run()).toBeNull();
    expect(db.tradingAccountSubscription.findUnique).not.toHaveBeenCalled();
    expect(db.signalEvaluation.create).not.toHaveBeenCalled();
  });
  it('returns immutable terminal evidence on retry without reading mutable state', async () => {
    const original = { id: 10, outcome: 'ELIGIBLE' };
    db.signalEvaluation.findUnique.mockResolvedValue(original);
    expect(await run()).toBe(original);
    expect(db.signalRoute.findUnique).not.toHaveBeenCalled();
    expect(db.signalEvaluation.create).not.toHaveBeenCalled();
  });
  it('reports structural target mismatch as processing failure', async () => {
    assignment.subscription.strategyId = 99;
    expect(await run()).toMatchObject({ status: 'FAILED', outcome: null, reasonCode: 'ROUTE_TARGET_INTEGRITY' });
    expect(db.systemEvent.create).toHaveBeenCalledOnce();
  });
  it('respects exit controls independently of entry controls', async () => {
    route.routingRun.signal.event = 'EXIT_LONG'; assignment.entriesEnabled = false; assignment.exitsEnabled = false;
    expect(await run()).toMatchObject({ outcome: 'BLOCKED', reasonCode: 'EXIT_MANAGEMENT_DISABLED' });
    expect(db.trackedPosition.findMany).not.toHaveBeenCalled();
  });
  it('does nothing when no originating open position matches', async () => {
    route.routingRun.signal.event = 'EXIT_LONG';
    expect(await run()).toMatchObject({ outcome: 'NO_ACTION', reasonCode: 'NO_MATCHING_OPEN_POSITION' });
    expect(db.trackedPosition.findMany.mock.calls[0]![0].where).toEqual({ tradingAccountId: 2,
      tradingAccountSubscriptionId: 3, subscriptionId: 4, securityId: 6, side: 'long', status: 'open' });
  });
  it.each(['BACKEND_MANAGED', 'EXTERNAL_SIGNAL'])('uses frozen %s ownership rather than current subscription mode', async mode => {
    route.routingRun.signal.event = 'EXIT_LONG';
    assignment.subscription.exitManagementMode = mode === 'EXTERNAL_SIGNAL' ? 'BACKEND_MANAGED' : 'EXTERNAL_SIGNAL';
    db.trackedPosition.findMany.mockResolvedValue([{ id: 20, exitState: { id: 30, exitManagementModeSnapshot: mode,
      exitOwnershipProvenance: { tradingAccountId: 2, tradingAccountSubscriptionId: 3, subscriptionId: 4, strategyId: 5, securityId: 6 } } }]);
    expect(await run()).toMatchObject({ outcome: mode === 'EXTERNAL_SIGNAL' ? 'ELIGIBLE' : 'NO_ACTION',
      reasonCode: mode === 'EXTERNAL_SIGNAL' ? null : 'EXTERNAL_EXIT_NOT_APPLICABLE',
      trackedPositionId: 20, positionExitStateId: 30, positionExitManagementMode: mode });
    expect(db.systemEvent.create).not.toHaveBeenCalled();
  });
  it('fails closed on ambiguous matching positions', async () => {
    route.routingRun.signal.event = 'EXIT_LONG';
    db.trackedPosition.findMany.mockResolvedValue([{ id: 20 }, { id: 21 }]);
    expect(await run()).toMatchObject({ status: 'FAILED', outcome: null, reasonCode: 'AMBIGUOUS_MATCHING_POSITIONS' });
  });
  it('cannot target an external position whose subscription was reassigned to another strategy', async () => {
    route.routingRun.signal.event = 'EXIT_LONG';
    db.trackedPosition.findMany.mockResolvedValue([{ id: 20, exitState: { id: 30, exitManagementModeSnapshot: 'EXTERNAL_SIGNAL',
      exitOwnershipProvenance: { tradingAccountId: 2, tradingAccountSubscriptionId: 3, subscriptionId: 4, strategyId: 999, securityId: 6 } } }]);
    expect(await run()).toMatchObject({ status: 'FAILED', outcome: null, reasonCode: 'POSITION_ORIGIN_INTEGRITY' });
  });
  it('does not create missing position lifecycle evidence', async () => {
    route.routingRun.signal.event = 'EXIT_LONG';
    db.trackedPosition.findMany.mockResolvedValue([{ id: 20, exitState: null }]);
    expect(await run()).toMatchObject({ status: 'FAILED', outcome: null, reasonCode: 'MISSING_POSITION_EXIT_SNAPSHOT' });
  });
  it('has no trading pipeline imports or trading write delegates', () => {
    const source = readFileSync(new URL('./signal-evaluation.service.ts', import.meta.url), 'utf8');
    expect([...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(m => m[1])).toEqual(['@prisma/client', '../db/prisma.js']);
    for (const forbidden of ['orderIntent', 'brokerOrder', 'brokerActivity', 'entryDecision', 'fetch(', 'closePosition', 'placeOrder',
      'trackedPosition.update', 'trackedPosition.create', 'positionExitState.update', 'tradingEnabled', 'ALLOW_LIVE_TRADING']) expect(source).not.toContain(forbidden);
  });
});

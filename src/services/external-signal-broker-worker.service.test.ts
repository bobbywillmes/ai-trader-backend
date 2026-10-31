import { describe, expect, it, vi } from 'vitest';
import { processTradingViewOrderIntentForC2, recoverTradingViewC2Claim, retryableConcurrencyFailure } from './external-signal-broker-worker.service.js';
import { observeTradingViewDeliveryUncertaintyForIntent } from './external-signal-delivery-attention.service.js';

vi.mock('../db/prisma.js', () => ({ prisma: {} }));
vi.mock('./external-signal-delivery-attention.service.js', () => ({ observeTradingViewDeliveryUncertaintyForIntent: vi.fn(async () => false) }));
vi.mock('./entry-dispatch-recovery.service.js', () => ({ releaseUnsubmittedOrRouteToRecovery: vi.fn(async () => ({ released: true, outcome: 'RELEASED' })) }));
vi.mock('./risk-gate.service.js', () => ({ evaluateOrderRisk: vi.fn(), logRiskGateBlockedOrder: vi.fn() }));
vi.mock('./order-audit.service.js', () => ({ recordOrderIntentRiskEvaluation: vi.fn() }));
vi.mock('./trading-account-entry-risk-usage.service.js', () => ({ getSizingEstimatedNotional: vi.fn(() => null) }));

/** The object Prisma's pg adapter throws, with the fields DriverAdapterError defines. */
const adapterError = (cause: Record<string, unknown>) => Object.assign(new Error('driver failure'), { name: 'DriverAdapterError', cause });

describe('TradingView C2 concurrency error classification', () => {
  it.each([
    [{ code: 'P2034' }, true],
    [{ code: 'P2010', meta: { code: '40001' } }, true],
    [{ code: 'P2010', meta: { code: '40P01' } }, true],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001' } } } }, true],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }, true],
    [{ code: 'P2010', meta: { code: '23505' } }, false],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: 'P0001' } } }, message: 'deadlock detected' }, false],
    [{ code: 'P2010', message: 'SQLSTATE 40001 serialization failure' }, false],
    [{ code: 'P2002', meta: { code: '40001' } }, false],
    [{ code: '40001', severity: 'ERROR' }, true],
    [{ code: '40P01', severity: 'ERROR' }, true],
    [{ cause: { originalCode: '40001' } }, false],
    [{ name: 'Error', cause: { originalCode: '40P01' } }, false],
    [{ name: 'DriverAdapterError', cause: { originalCode: 'P0001', originalMessage: 'deadlock detected 40001' } }, false],
    [{ name: 'DriverAdapterError', cause: { originalCode: 40001 } }, false],
    [{ name: 'DriverAdapterError', cause: { kind: 'postgres', message: 'could not serialize access' } }, false],
    [{ name: 'DriverAdapterError' }, false],
  ] as const)('classifies %j as retryable=%s', (error, expected) => {
    expect(retryableConcurrencyFailure(error)).toBe(expected);
  });

  it('classifies a top-level DriverAdapterError by its structured SQLSTATE only', () => {
    expect(retryableConcurrencyFailure(adapterError({ originalCode: '40001', originalMessage: 'could not serialize access', kind: 'TransactionWriteConflict' }))).toBe(true);
    expect(retryableConcurrencyFailure(adapterError({ originalCode: '40P01', originalMessage: 'deadlock detected', kind: 'postgres' }))).toBe(true);
    expect(retryableConcurrencyFailure(new Error('could not serialize access 40001 deadlock detected 40P01'))).toBe(false);
    expect(retryableConcurrencyFailure(null)).toBe(false);
  });
});

describe('TradingView C2 bounded transaction retries', () => {
  const refusableCandidate = {
    id: 7, status: 'pending', externalSignalAccountCycleId: 3, clientOrderId: 'c', tradingAccountId: 1, tradingAccountSubscriptionId: 2, subscriptionId: 4, side: 'buy', symbol: 'X', orderType: 'market', timeInForce: 'day',
    rawRequestJson: { tradingAccountSubscriptionId: 2 },
    externalSignalOriginAccountCycle: { securityId: 5, entryExecutionObligation: { id: 9, rolloutGenerationId: 1, entrySignal: { createdAt: new Date() } }, accountSubscription: { id: 999, tradingAccountId: 1, subscriptionId: 4 } },
  };
  const stubDb = ($transaction: unknown, row: unknown = refusableCandidate) => ({ $transaction, orderIntent: { findUnique: vi.fn(async () => row) } }) as never;

  it('gives every retry a fresh transaction and fails closed after the bound', async () => {
    const failure = adapterError({ originalCode: '40001' });
    const transaction = vi.fn(async () => { throw failure; });
    await expect(processTradingViewOrderIntentForC2(7, { db: stubDb(transaction) })).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry an application refusal, even one that mentions a deadlock', async () => {
    const refusal = Object.assign(new Error('deadlock detected 40P01'), { code: 'P0001' });
    const transaction = vi.fn(async () => { throw refusal; });
    await expect(processTradingViewOrderIntentForC2(7, { db: stubDb(transaction) })).rejects.toBe(refusal);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('classifies a refusal transaction that finds no pending claim as a lost race after a retry', async () => {
    const results = [adapterError({ originalCode: '40P01' }), false];
    const transaction = vi.fn(async () => { const next = results.shift(); if (next instanceof Error) throw next; return next; });
    await expect(processTradingViewOrderIntentForC2(7, { db: stubDb(transaction) })).resolves.toEqual({ outcome: 'LOST_REFUSAL_RACE' });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('recovery reports uncertainty without attempting refusal, and rethrows a failure with no such evidence', async () => {
    const row = { id: 7, status: 'submitting', tradingAccountId: 1, externalSignalBrokerWorkerClaim: { id: 2 }, entryExposureClaim: { id: 3 } };
    const observe = vi.mocked(observeTradingViewDeliveryUncertaintyForIntent);
    observe.mockResolvedValueOnce(true);
    const untouched = vi.fn();
    await expect(recoverTradingViewC2Claim(7, { db: stubDb(untouched, row) })).resolves.toEqual({ outcome: 'OPERATIONAL_ATTENTION' });
    expect(untouched).not.toHaveBeenCalled();
    const outage = new Error('connection lost');
    await expect(recoverTradingViewC2Claim(7, { db: stubDb(vi.fn(async () => { throw outage; }), row) })).rejects.toBe(outage);
  });
});

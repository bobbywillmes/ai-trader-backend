import { describe, expect, it, vi } from 'vitest';
import { processTradingViewOrderIntentForC2, recoverTradingViewC2Claim, retryableConcurrencyFailure } from './external-signal-broker-worker.service.js';
import { observeTradingViewDeliveryUncertaintyForIntent } from './external-signal-delivery-attention.service.js';

vi.mock('../db/prisma.js', () => ({ prisma: {} }));
vi.mock('./external-signal-delivery-attention.service.js', () => ({ observeTradingViewDeliveryUncertaintyForIntent: vi.fn(async () => false) }));
vi.mock('./entry-dispatch-recovery.service.js', () => ({ releaseUnsubmittedOrRouteToRecovery: vi.fn(async () => ({ released: true, outcome: 'RELEASED' })) }));
vi.mock('./risk-gate.service.js', () => ({ evaluateOrderRisk: vi.fn(), logRiskGateBlockedOrder: vi.fn() }));
vi.mock('./order-audit.service.js', () => ({ recordOrderIntentRiskEvaluation: vi.fn() }));
vi.mock('./trading-account-entry-risk-usage.service.js', () => ({ getSizingEstimatedNotional: vi.fn(() => null) }));

import { Prisma } from '@prisma/client';
import { DriverAdapterError } from '@prisma/driver-adapter-utils';
import pg from 'pg';

/** The error Prisma's pg adapter throws: a real DriverAdapterError carrying the server SQLSTATE. */
const adapterError = (cause: Record<string, unknown>) => new DriverAdapterError({ kind: 'postgres', code: String(cause.originalCode ?? ''), severity: 'ERROR', message: 'driver failure', detail: undefined, column: undefined, hint: undefined, ...cause } as never);
const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError('prisma failure', { code, clientVersion: 'test', ...(meta ? { meta } : {}) });
const pgError = (code: string) => Object.assign(new pg.DatabaseError('pg failure', 0, 'error'), { code });

describe('TradingView C2 concurrency error classification', () => {
  it.each([
    ['P2034', known('P2034'), true],
    ['P2010 meta.code 40001', known('P2010', { code: '40001' }), true],
    ['P2010 meta.code 40P01', known('P2010', { code: '40P01' }), true],
    ['P2010 driver cause 40001', known('P2010', { driverAdapterError: { cause: { originalCode: '40001' } } }), true],
    ['P2010 driver cause 40P01', known('P2010', { driverAdapterError: { cause: { originalCode: '40P01' } } }), true],
    ['P2010 unique violation', known('P2010', { code: '23505' }), false],
    ['P2010 application P0001 with deadlock text', Object.assign(known('P2010', { driverAdapterError: { cause: { originalCode: 'P0001' } } }), { message: 'deadlock detected' }), false],
    ['P2010 message only', Object.assign(known('P2010'), { message: 'SQLSTATE 40001 serialization failure' }), false],
    ['P2002 carrying a 40001 meta', known('P2002', { code: '40001' }), false],
    ['pg 40001', pgError('40001'), true],
    ['pg 40P01', pgError('40P01'), true],
    ['pg unique violation', pgError('23505'), false],
    ['adapter 40001', adapterError({ originalCode: '40001' }), true],
    ['adapter 40P01', adapterError({ originalCode: '40P01' }), true],
    ['adapter application P0001 with 40001 text', adapterError({ originalCode: 'P0001', originalMessage: 'deadlock detected 40001' }), false],
    ['adapter without SQLSTATE', adapterError({ originalCode: undefined, originalMessage: 'could not serialize access' }), false],
    ['plain Error with SQLSTATE text', new Error('could not serialize access 40001 deadlock detected 40P01'), false],
    ['null', null, false],
  ] as const)('classifies a real %s error as retryable=%s', (_label, error, expected) => {
    expect(retryableConcurrencyFailure(error)).toBe(expected);
  });

  it.each([
    [{ code: 'P2034' }],
    [{ code: 'P2010', meta: { code: '40001' } }],
    [{ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }],
    [{ code: '40001', severity: 'ERROR' }],
    [{ code: '40P01' }],
    [{ name: 'DriverAdapterError', cause: { originalCode: '40001' } }],
    [Object.assign(new Error('driver failure'), { name: 'DriverAdapterError', cause: { originalCode: '40P01' } })],
    [Object.assign(new Error('fake'), { name: 'PrismaClientKnownRequestError', code: 'P2034' })],
    [Object.assign(new Error('fake'), { code: '40001' })],
    [Object.assign(Object.create(null), { code: 'P2034' })],
  ])('rejects the constructed lookalike %j for lacking error-type provenance', (error) => {
    expect(retryableConcurrencyFailure(error)).toBe(false);
  });
});

describe('TradingView C2 bounded transaction retries', () => {
  const refusableCandidate = {
    id: 7, status: 'pending', externalSignalAccountCycleId: 3, clientOrderId: 'c', tradingAccountId: 1, tradingAccountSubscriptionId: 2, subscriptionId: 4, side: 'buy', symbol: 'X', orderType: 'market', timeInForce: 'day',
    rawRequestJson: { tradingAccountSubscriptionId: 2 },
    externalSignalOriginAccountCycle: { securityId: 5, entryExecutionObligation: { id: 9, rolloutGenerationId: 1, entrySignal: { id: 77 } }, accountSubscription: { id: 999, tradingAccountId: 1, subscriptionId: 4 } },
  };
  const stubDb = ($transaction: unknown, row: unknown = refusableCandidate) => ({ $transaction, $queryRaw: vi.fn(async () => [{ open: true }]), orderIntent: { findUnique: vi.fn(async () => row) } }) as never;

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

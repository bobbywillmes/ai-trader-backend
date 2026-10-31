import { describe, expect, it } from 'vitest';
import { retryableConcurrencyFailure } from './external-signal-broker-worker.service.js';

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
  ] as const)('classifies %j as retryable=%s', (error, expected) => {
    expect(retryableConcurrencyFailure(error)).toBe(expected);
  });
});

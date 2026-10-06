import { describe, expect, it, vi } from 'vitest';
import type { ReferencePriceEvidence } from './live-market-data.contracts.js';
import { getTradingReferencePrice } from './trading-reference-price.service.js';

const regularNow = new Date('2026-10-02T16:00:00.000Z');
const evidence = (patch: Partial<ReferencePriceEvidence> = {}): ReferencePriceEvidence => ({
  symbol: 'SPY', provider: 'TIINGO_CONSOLIDATED', price: 100,
  basis: 'TIINGO_TNGO_LAST', observedAt: '2026-10-02T15:59:00.000Z',
  fetchedAt: regularNow.toISOString(), freshness: 'FRESH', available: true,
  unavailableReason: null, providerError: null, ...patch,
});

describe('shared trading reference-price service', () => {
  it('selects only Tiingo consolidated and applies the accepted policy', async () => {
    const verify = vi.fn().mockResolvedValue(evidence());
    const calendar = vi.fn().mockResolvedValue([]);

    await expect(getTradingReferencePrice(' spy ', regularNow, { verify, calendar }))
      .resolves.toMatchObject({ provider: 'TIINGO_CONSOLIDATED', basis: 'TIINGO_TNGO_LAST', usable: true });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('SPY', 'TIINGO_CONSOLIDATED', regularNow);
    expect(calendar).toHaveBeenCalledWith('2026-10-02', '2026-10-02');
  });

  it.each([
    ['LQ reference price', { basis: 'TIINGO_LQ_REF_PRICE' }, 'UNACCEPTED_BASIS'],
    ['stale observation', { observedAt: '2026-10-02T15:54:59.999Z' }, 'STALE_OBSERVATION'],
    ['future observation beyond tolerance', { observedAt: '2026-10-02T16:00:30.001Z' }, 'FUTURE_OBSERVATION'],
    ['provider error', { price: null, providerError: 'HTTP_429', unavailableReason: 'PROVIDER_ERROR' }, 'PROVIDER_ERROR'],
  ] as const)('rejects %s without a fallback request', async (_label, patch, reason) => {
    const verify = vi.fn().mockResolvedValue(evidence(patch as Partial<ReferencePriceEvidence>));
    await expect(getTradingReferencePrice('SPY', regularNow, { verify, calendar: async () => [] }))
      .resolves.toMatchObject({ usable: false, rejectionReason: reason });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[1]).toBe('TIINGO_CONSOLIDATED');
  });

  it('accepts future skew at the tolerance boundary', async () => {
    const verify = vi.fn().mockResolvedValue(evidence({ observedAt: '2026-10-02T16:00:30.000Z' }));
    await expect(getTradingReferencePrice('SPY', regularNow, { verify, calendar: async () => [] }))
      .resolves.toMatchObject({ usable: true, ageMs: -30_000, clockSkewMs: 30_000 });
  });

  it.each([
    ['premarket', '2026-10-02T12:00:00.000Z'],
    ['postmarket', '2026-10-02T21:00:00.000Z'],
    ['weekend', '2026-10-03T16:00:00.000Z'],
  ])('rejects %s before evidence quality can grant authority', async (_label, timestamp) => {
    const now = new Date(timestamp);
    const verify = vi.fn().mockResolvedValue(evidence({ observedAt: timestamp, fetchedAt: timestamp }));
    await expect(getTradingReferencePrice('SPY', now, { verify, calendar: async () => [] }))
      .resolves.toMatchObject({ usable: false, rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION' });
  });

  it('rejects a reviewed holiday', async () => {
    const verify = vi.fn().mockResolvedValue(evidence());
    await expect(getTradingReferencePrice('SPY', regularNow, {
      verify,
      calendar: async () => [{ sessionDate: '2026-10-02', type: 'CLOSED', closeTimeMinutesEt: null }],
    })).resolves.toMatchObject({ usable: false, rejectionReason: 'OUTSIDE_TRADING_PRICE_SESSION' });
  });
});

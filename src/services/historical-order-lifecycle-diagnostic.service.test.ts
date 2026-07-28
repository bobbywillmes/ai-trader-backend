import { describe, expect, it } from 'vitest';

import {
  classifyLocalFillEvidence,
  HISTORICAL_POSITION_TIME_TOLERANCE_MS,
  HISTORICAL_PRICE_TOLERANCE,
  HISTORICAL_QUANTITY_TOLERANCE,
  matchHistoricalEntryPosition,
} from './historical-order-lifecycle-diagnostic.service.js';

const fillTime = new Date('2026-01-02T12:00:00.000Z');
const input = {
  tradingAccountId: 1,
  broker: 'alpaca',
  symbol: 'DIA',
  side: 'buy',
  qty: 1,
  fillPrice: 400,
  fillTime,
  subscriptionId: 5,
  tradingAccountSubscriptionId: 9,
};
const candidate = {
  id: 51,
  tradingAccountId: 1,
  broker: 'alpaca',
  symbol: 'DIA',
  qty: 1,
  avgEntryPrice: 400,
  openedAt: fillTime,
  subscriptionId: 5,
  tradingAccountSubscriptionId: 9,
};

describe('matchHistoricalEntryPosition', () => {
  it('returns the one exact account and assignment scoped match', () => {
    expect(matchHistoricalEntryPosition(input, [candidate])).toMatchObject({
      status: 'exact',
      match: { id: 51 },
    });
  });

  it.each([-1, 1])('accepts a timestamp on either side of the fill (%s)', (direction) => {
    const openedAt = new Date(
      fillTime.getTime() + direction * HISTORICAL_POSITION_TIME_TOLERANCE_MS
    );
    expect(
      matchHistoricalEntryPosition(input, [{ ...candidate, openedAt }]).status
    ).toBe('exact');
  });

  it('accepts centralized quantity and price tolerances', () => {
    expect(
      matchHistoricalEntryPosition(input, [
        {
          ...candidate,
          qty: 1 + HISTORICAL_QUANTITY_TOLERANCE,
          avgEntryPrice: 400 + HISTORICAL_PRICE_TOLERANCE,
        },
      ]).status
    ).toBe('exact');
  });

  it.each([
    { tradingAccountId: 2 },
    { tradingAccountSubscriptionId: 10 },
    { subscriptionId: 6 },
    { qty: 2 },
    { avgEntryPrice: 401 },
    { broker: 'other' },
  ])('refuses mismatched ownership or economics: %j', (override) => {
    expect(
      matchHistoricalEntryPosition(input, [{ ...candidate, ...override }]).status
    ).toBe('missing');
  });

  it('refuses multiple qualifying candidates rather than choosing closest', () => {
    expect(
      matchHistoricalEntryPosition(input, [
        candidate,
        { ...candidate, id: 52, openedAt: new Date(fillTime.getTime() + 1) },
      ])
    ).toMatchObject({ status: 'ambiguous' });
  });

  it('refuses incomplete evidence', () => {
    expect(
      matchHistoricalEntryPosition({ ...input, tradingAccountSubscriptionId: null }, [
        candidate,
      ]).status
    ).toBe('missing');
  });
});

describe('classifyLocalFillEvidence', () => {
  const activity = {
    activityType: 'FILL',
    cumQty: 1,
    leavesQty: 0,
    price: 400,
    transactionTime: fillTime,
    tradingAccountId: 1,
    brokerOrderRecordId: 20,
  };

  it('recognizes an ownership-scoped cumulative full fill', () => {
    expect(
      classifyLocalFillEvidence({
        orderQty: 1,
        tradingAccountId: 1,
        brokerOrderRecordId: 20,
        activities: [activity],
      })
    ).toBe('full');
  });

  it('keeps partial fills nonterminal', () => {
    expect(
      classifyLocalFillEvidence({
        orderQty: 1,
        tradingAccountId: 1,
        brokerOrderRecordId: 20,
        activities: [{ ...activity, cumQty: 0.5, leavesQty: 0.5 }],
      })
    ).toBe('partial');
  });

  it('rejects activity from another account or broker-order record', () => {
    expect(
      classifyLocalFillEvidence({
        orderQty: 1,
        tradingAccountId: 1,
        brokerOrderRecordId: 20,
        activities: [{ ...activity, tradingAccountId: 2 }],
      })
    ).toBe('none');
  });
});

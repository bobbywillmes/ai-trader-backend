import { describe, expect, it } from 'vitest';

import {
  buildHistoricalPositionCandidateWhere,
  classifyLocalFillEvidence,
  evaluateHistoricalPositionCandidates,
  formatHistoricalPositionMatchDiagnostics,
  HISTORICAL_POSITION_TIME_TOLERANCE_MS,
  HISTORICAL_PRICE_TOLERANCE,
  HISTORICAL_QUANTITY_TOLERANCE,
  matchHistoricalEntryPosition,
  summarizeLocalFillEvidence,
  validateExistingHistoricalPositionLink,
  assessHistoricalFullFillEvidence,
} from './historical-order-lifecycle-diagnostic.service.js';

describe('historical full-fill repair evidence', () => {
  const activity = {
    id: 101, activityType: 'FILL', qty: 2, cumQty: 2, leavesQty: 0,
    price: 125.5, transactionTime: fillTime, tradingAccountId: 7,
    brokerOrderRecordId: 11, orderId: 'synthetic-order', broker: 'alpaca',
  };

  it('accepts exact owned full-fill evidence without changing financial values', () => {
    expect(assessHistoricalFullFillEvidence({ orderQty: 2, tradingAccountId: 7, brokerOrderRecordId: 11, brokerOrderId: 'synthetic-order', activities: [activity] })).toMatchObject({
      deterministic: true, contradictions: [], ownedActivityIds: [101],
      summary: { classification: 'full', weightedAveragePrice: 125.5 },
    });
  });

  it.each([
    ['missing price', { ...activity, price: null }, 'missing_or_invalid_fill_price'],
    ['quantity contradiction', { ...activity, qty: 1 }, 'priced_fill_quantity_conflicts_with_order_quantity'],
    ['broker identity contradiction', { ...activity, orderId: 'different-order' }, 'conflicting_broker_order_identity'],
  ])('refuses deterministic terminalization for %s', (_label, changed, reason) => {
    const result = assessHistoricalFullFillEvidence({ orderQty: 2, tradingAccountId: 7, brokerOrderRecordId: 11, brokerOrderId: 'synthetic-order', activities: [changed] });
    expect(result.deterministic).toBe(false);
    expect(result.contradictions).toContain(reason);
  });
});

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
    const result = matchHistoricalEntryPosition(input, [
        candidate,
        { ...candidate, id: 52, openedAt: new Date(fillTime.getTime() + 1) },
      ]);
    expect(result).toMatchObject({ status: 'ambiguous' });
    expect(formatHistoricalPositionMatchDiagnostics(result)).toEqual({
      candidatePositionEvaluations: [
        { trackedPositionId: 51, rejectionReasons: ['ambiguity'] },
        { trackedPositionId: 52, rejectionReasons: ['ambiguity'] },
      ],
      positionMatchRejectionReason: 'ambiguity',
    });
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
    qty: 1,
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

describe('summarizeLocalFillEvidence', () => {
  it('uses two incremental fills, their weighted price, and final cumulative completion', () => {
    const result = summarizeLocalFillEvidence({
      orderQty: 2,
      tradingAccountId: 1,
      brokerOrderRecordId: 20,
      activities: [
        {
          activityType: 'FILL',
          qty: 0.5,
          cumQty: 0.5,
          leavesQty: 1.5,
          price: 100,
          transactionTime: new Date('2026-01-02T11:59:58.000Z'),
          tradingAccountId: 1,
          brokerOrderRecordId: 20,
        },
        {
          activityType: 'FILL',
          qty: 1.5,
          cumQty: 2,
          leavesQty: 0,
          price: 102,
          transactionTime: fillTime,
          tradingAccountId: 1,
          brokerOrderRecordId: 20,
        },
      ],
    });

    expect(result).toEqual({
      classification: 'full',
      cumulativeQty: 2,
      leavesQty: 0,
      weightedAveragePrice: 101.5,
      completionTime: fillTime,
      activityCount: 2,
    });
    expect(
      matchHistoricalEntryPosition(
        {
          ...input,
          qty: 2,
          fillPrice: result.weightedAveragePrice,
          fillTime: result.completionTime,
        },
        [
          {
            ...candidate,
            qty: 2,
            avgEntryPrice: 101.5,
          },
        ]
      ).status
    ).toBe('exact');
  });
});

describe('evaluateHistoricalPositionCandidates', () => {
  it('reports structured rejection reasons without loosening price tolerance', () => {
    const evaluations = evaluateHistoricalPositionCandidates(input, [
      {
        ...candidate,
        tradingAccountId: 2,
        broker: 'other',
        symbol: 'QQQ',
        subscriptionId: 6,
        tradingAccountSubscriptionId: 10,
        qty: 2,
        avgEntryPrice: input.fillPrice + HISTORICAL_PRICE_TOLERANCE + 0.000001,
        openedAt: new Date(
          fillTime.getTime() + HISTORICAL_POSITION_TIME_TOLERANCE_MS + 1
        ),
      },
    ]);

    expect(evaluations[0]?.rejectionReasons).toEqual([
      'account_mismatch',
      'broker_mismatch',
      'symbol_mismatch',
      'subscription_mismatch',
      'assignment_mismatch',
      'quantity_mismatch',
      'price_outside_tolerance',
      'time_outside_window',
    ]);
  });
});

describe('validateExistingHistoricalPositionLink', () => {
  it('accepts one consistently referenced position with matching ownership', () => {
    expect(
      validateExistingHistoricalPositionLink({
        existingPositionIds: [51, 51, 51],
        tradingAccountId: 1,
        broker: 'alpaca',
        symbol: 'DIA',
        subscriptionId: 5,
        tradingAccountSubscriptionId: 9,
        positions: [candidate],
      })
    ).toMatchObject({ status: 'valid', trackedPositionId: 51 });
  });

  it('accepts a partially populated but consistent existing link', () => {
    expect(
      validateExistingHistoricalPositionLink({
        existingPositionIds: [51],
        tradingAccountId: 1,
        broker: 'alpaca',
        symbol: 'DIA',
        subscriptionId: 5,
        tradingAccountSubscriptionId: 9,
        positions: [candidate],
      }).status
    ).toBe('valid');
  });

  it('refuses conflicting existing links', () => {
    expect(
      validateExistingHistoricalPositionLink({
        existingPositionIds: [51, 52],
        tradingAccountId: 1,
        broker: 'alpaca',
        symbol: 'DIA',
        subscriptionId: 5,
        tradingAccountSubscriptionId: 9,
        positions: [candidate],
      }).status
    ).toBe('conflicting');
  });

  it('refuses a referenced position owned by another account', () => {
    expect(
      validateExistingHistoricalPositionLink({
        existingPositionIds: [51],
        tradingAccountId: 1,
        broker: 'alpaca',
        symbol: 'DIA',
        subscriptionId: 5,
        tradingAccountSubscriptionId: 9,
        positions: [{ ...candidate, tradingAccountId: 2 }],
      })
    ).toMatchObject({
      status: 'invalid',
      rejectionReasons: ['account_mismatch'],
    });
  });
});

describe('buildHistoricalPositionCandidateWhere', () => {
  it('loads an existing referenced position for a filled sell without entry matching', () => {
    expect(
      buildHistoricalPositionCandidateWhere({
        includeEntryMatchCandidates: false,
        tradingAccountId: 1,
        broker: 'alpaca',
        symbol: 'DIA',
        completionTime: fillTime,
        existingPositionIds: [41],
      })
    ).toEqual({ OR: [{ id: { in: [41] } }] });
  });

  it('does not query positions for an unlinked non-entry lifecycle group', () => {
    expect(
      buildHistoricalPositionCandidateWhere({
        includeEntryMatchCandidates: false,
        tradingAccountId: 1,
        broker: 'alpaca',
        symbol: 'DIA',
        completionTime: fillTime,
        existingPositionIds: [],
      })
    ).toBeNull();
  });
});

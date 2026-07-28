import { describe, expect, it } from 'vitest';

import {
  buildHistoricalOrderRepairProposal,
  repairHistoricalOrderLifecycle,
} from './historical-order-lifecycle-repair.service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    tradingAccountId: 1,
    orderIntentId: 10,
    brokerOrderRecordId: 20,
    brokerOrderId: 'broker-20',
    clientOrderId: 'client-20',
    symbol: 'DIA',
    side: 'buy',
    quantity: 1,
    subscriptionId: 5,
    tradingAccountSubscriptionId: 9,
    createdAt: new Date(),
    classifications: ['FULL_FILL_LOCAL_EVIDENCE', 'POSITION_LINK_EXACT'],
    matchedTrackedPositionId: 30,
    candidateTrackedPositionIds: [30],
    brokerLookup: null,
    ...overrides,
  } as never;
}

describe('buildHistoricalOrderRepairProposal', () => {
  it('proposes filled terminalization and linking only for exact full-fill evidence', () => {
    expect(buildHistoricalOrderRepairProposal(row())).toEqual({
      kind: 'filled_entry',
      orderIntentId: 10,
      brokerOrderRecordId: 20,
      trackedPositionId: 30,
      brokerOrderStatus: 'filled',
      orderIntentStatus: 'filled',
      evidence: ['FULL_FILL_LOCAL_EVIDENCE', 'POSITION_LINK_EXACT'],
    });
  });

  it('proposes authoritative canceled, rejected, and expired outcomes without links', () => {
    for (const status of ['canceled', 'rejected', 'expired']) {
      expect(
        buildHistoricalOrderRepairProposal(
          row({
            classifications: ['TERMINAL_BROKER_CONFIRMED'],
            matchedTrackedPositionId: null,
            candidateTrackedPositionIds: [],
            brokerLookup: { id: '1', clientOrderId: '2', status },
          })
        )
      ).toMatchObject({
        kind: 'terminal_nonfilled',
        brokerOrderStatus: status,
        orderIntentStatus: status,
        trackedPositionId: null,
      });
    }
  });

  it.each([
    ['partial fill', ['PARTIAL_FILL_LOCAL_EVIDENCE']],
    ['ambiguous match', ['FULL_FILL_LOCAL_EVIDENCE', 'POSITION_LINK_AMBIGUOUS']],
    ['missing match', ['FULL_FILL_LOCAL_EVIDENCE', 'POSITION_LINK_MISSING']],
    ['nonterminal broker order', ['NONTERMINAL_BROKER_CONFIRMED']],
    ['failed lookup', ['BROKER_LOOKUP_FAILED']],
  ])('refuses %s', (_name, classifications) => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          classifications,
          matchedTrackedPositionId: null,
          candidateTrackedPositionIds: [],
        })
      )
    ).toBeNull();
  });

  it('does not mark a broker-confirmed fill complete without an exact position link', () => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          classifications: ['TERMINAL_BROKER_CONFIRMED'],
          matchedTrackedPositionId: null,
          candidateTrackedPositionIds: [],
          brokerLookup: { id: '1', clientOrderId: '2', status: 'filled' },
        })
      )
    ).toBeNull();
  });
});

describe('repairHistoricalOrderLifecycle apply guard', () => {
  it('requires the exact apply confirmation before any diagnostic work', async () => {
    await expect(
      repairHistoricalOrderLifecycle({
        tradingAccountId: 1,
        apply: true,
        confirmation: 'wrong',
      })
    ).rejects.toThrow('Apply mode requires');
  });
});

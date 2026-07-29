import { describe, expect, it } from 'vitest';

import {
  assertApplyReportUnchanged,
  buildHistoricalOrderRepairProposal,
  countPendingRepairIntents,
  repairHistoricalOrderLifecycle,
  summarizeRepairCompleteness,
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
    brokerOrderStatus: 'accepted',
    orderIntentStatus: 'filled',
    blockReason: null,
    orderIntentTrackedPositionId: null,
    brokerOrderTrackedPositionId: null,
    activityTrackedPositionIds: [],
    fillEvidence: {
      cumulativeQty: 1,
      leavesQty: 0,
      weightedAveragePrice: 400,
      completionTime: new Date().toISOString(),
      activityCount: 1,
    },
    localStateFingerprint: 'state-v1',
    subscriptionId: 5,
    tradingAccountSubscriptionId: 9,
    createdAt: new Date(),
    classifications: ['FULL_FILL_LOCAL_EVIDENCE', 'POSITION_LINK_EXACT'],
    matchedTrackedPositionId: 30,
    validatedExistingTrackedPositionId: null,
    existingPositionLinkValidation: {
      status: 'missing',
      rejectionReasons: ['no_existing_link'],
    },
    candidateTrackedPositionIds: [30],
    candidatePositionEvaluations: [],
    positionMatchRejectionReason: null,
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

  it('repairs a filled entry from a validated existing lifecycle link', () => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          classifications: [
            'FULL_FILL_LOCAL_EVIDENCE',
            'POSITION_LINK_MISSING',
            'POSITION_LINK_EXISTING_VALID',
          ],
          matchedTrackedPositionId: null,
          validatedExistingTrackedPositionId: 30,
          orderIntentTrackedPositionId: 30,
          brokerOrderTrackedPositionId: 30,
          activityTrackedPositionIds: [30],
        })
      )
    ).toMatchObject({
      kind: 'filled_entry',
      trackedPositionId: 30,
      evidence: [
        'FULL_FILL_LOCAL_EVIDENCE',
        'POSITION_LINK_EXISTING_VALID',
      ],
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

  it('terminalizes a locally proven filled sell without requiring a position match', () => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          side: 'sell',
          classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
          matchedTrackedPositionId: null,
          candidateTrackedPositionIds: [],
          orderIntentTrackedPositionId: 30,
          brokerOrderTrackedPositionId: 30,
          activityTrackedPositionIds: [30],
          validatedExistingTrackedPositionId: 30,
          existingPositionLinkValidation: {
            status: 'valid',
            rejectionReasons: [],
          },
        })
      )
    ).toEqual({
      kind: 'filled_non_entry',
      orderIntentId: 10,
      brokerOrderRecordId: 20,
      trackedPositionId: 30,
      brokerOrderStatus: 'filled',
      orderIntentStatus: 'filled',
      evidence: ['FULL_FILL_LOCAL_EVIDENCE'],
    });
  });

  it('terminalizes an unlinked filled sell without fabricating a position', () => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          side: 'sell',
          classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
          matchedTrackedPositionId: null,
          candidateTrackedPositionIds: [],
        })
      )
    ).toMatchObject({
      kind: 'filled_non_entry',
      trackedPositionId: null,
    });
  });

  it.each([
    ['referenced position missing', ['referenced_position_missing']],
    ['cross-account position', ['account_mismatch']],
    ['symbol mismatch', ['symbol_mismatch']],
  ])('refuses a filled sell when %s', (_name, rejectionReasons) => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          side: 'sell',
          classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
          matchedTrackedPositionId: null,
          orderIntentTrackedPositionId: 41,
          brokerOrderTrackedPositionId: 41,
          activityTrackedPositionIds: [41],
          validatedExistingTrackedPositionId: null,
          existingPositionLinkValidation: {
            status: 'invalid',
            rejectionReasons,
          },
        })
      )
    ).toBeNull();
  });

  it('refuses conflicting intent, order, and activity links for a filled sell', () => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          side: 'sell',
          classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
          orderIntentTrackedPositionId: 41,
          brokerOrderTrackedPositionId: 42,
          activityTrackedPositionIds: [41],
          validatedExistingTrackedPositionId: null,
          existingPositionLinkValidation: {
            status: 'conflicting',
            rejectionReasons: ['conflicting_existing_links'],
          },
        })
      )
    ).toBeNull();
  });

  it('allows a valid entry and exit to share the same tracked position', () => {
    const validLink = {
      validatedExistingTrackedPositionId: 41,
      existingPositionLinkValidation: {
        status: 'valid',
        rejectionReasons: [],
      },
      orderIntentTrackedPositionId: 41,
      brokerOrderTrackedPositionId: 41,
      activityTrackedPositionIds: [41],
    };
    const entry = buildHistoricalOrderRepairProposal(
      row({
        ...validLink,
        classifications: [
          'FULL_FILL_LOCAL_EVIDENCE',
          'POSITION_LINK_EXISTING_VALID',
        ],
        matchedTrackedPositionId: null,
      })
    );
    const exit = buildHistoricalOrderRepairProposal(
      row({
        ...validLink,
        orderIntentId: 72,
        brokerOrderRecordId: 52,
        side: 'sell',
        classifications: [
          'FULL_FILL_LOCAL_EVIDENCE',
          'POSITION_LINK_EXISTING_VALID',
        ],
        matchedTrackedPositionId: null,
      })
    );
    expect(entry).toMatchObject({ trackedPositionId: 41 });
    expect(exit).toMatchObject({ trackedPositionId: 41 });
  });

  it('cannot produce a safe proposal carrying an invalid position ID', () => {
    const proposal = buildHistoricalOrderRepairProposal(
      row({
        side: 'sell',
        classifications: ['FULL_FILL_LOCAL_EVIDENCE'],
        orderIntentTrackedPositionId: 41,
        brokerOrderTrackedPositionId: 41,
        activityTrackedPositionIds: [41],
        existingPositionLinkValidation: {
          status: 'invalid',
          rejectionReasons: ['referenced_position_missing'],
        },
      })
    );
    expect(proposal).toBeNull();
    expect(
      summarizeRepairCompleteness({
        proposalCount: proposal ? 1 : 0,
        unresolvedCandidateCount: proposal ? 0 : 1,
        remainingPendingEntryExposureCount: 0,
      })
    ).toMatchObject({
      safeToApplyProposals: false,
      allCandidatesResolved: false,
    });
  });

  it('refuses an entry whose existing lifecycle link contradicts the exact match', () => {
    expect(
      buildHistoricalOrderRepairProposal(
        row({
          matchedTrackedPositionId: 30,
          activityTrackedPositionIds: [31],
        })
      )
    ).toBeNull();
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

describe('countPendingRepairIntents', () => {
  it('subtracts a pending buy repair but not a filled sell repair', () => {
    expect(
      countPendingRepairIntents(
        [
          row({
            orderIntentId: 10,
            side: 'buy',
            orderIntentStatus: 'filled',
            orderIntentTrackedPositionId: null,
          }),
          row({
            orderIntentId: 11,
            brokerOrderRecordId: 21,
            side: 'sell',
            orderIntentStatus: 'submitted',
            orderIntentTrackedPositionId: 30,
          }),
        ],
        new Set([10, 11])
      )
    ).toBe(1);
  });
});

describe('summarizeRepairCompleteness', () => {
  it('separates safe proposals from unresolved account-wide work', () => {
    expect(
      summarizeRepairCompleteness({
        proposalCount: 22,
        unresolvedCandidateCount: 26,
        remainingPendingEntryExposureCount: 1,
      })
    ).toEqual({
      safeToApplyProposals: true,
      allCandidatesResolved: false,
      unresolvedCandidateCount: 26,
      remainingPendingEntryExposureCount: 1,
    });
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

describe('assertApplyReportUnchanged', () => {
  it('refuses when lifecycle state changes after broker evidence is gathered', () => {
    const proposal = buildHistoricalOrderRepairProposal(row())!;
    const initial = {
      proposals: [{ row: row(), proposal }],
    } as never;
    const final = {
      proposals: [
        {
          row: row({
            brokerOrderStatus: 'filled',
            localStateFingerprint: 'state-v2',
          }),
          proposal,
        },
      ],
    } as never;

    expect(() =>
      assertApplyReportUnchanged({ initial, final })
    ).toThrow(
      'Lifecycle group 20 changed after broker evidence was gathered.'
    );
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/prisma.js', () => ({ prisma: {} }));

import {
  evaluateNeverSubmittedRelease,
  preserveBlockReason,
  summarizeDeliveryEvidence,
  type DeliveryEvidenceEvent,
} from './entry-delivery-evidence.service.js';
import { classifyTerminalEntryClaim, type TerminalClaimCandidate } from './entry-dispatch-recovery.service.js';

const at = new Date('2026-10-20T12:00:00.000Z');
const event = (id: number, eventType: string, evidenceJson: Record<string, unknown> = {}, createdAt = at): DeliveryEvidenceEvent => ({ id, eventType, evidenceJson: evidenceJson as never, createdAt });
const claimed = (id: number) => event(id, 'WORKER_CLAIMED_FOR_SUBMISSION', { markerProtocol: 'ADAPTER_MARKER_V1' });
const marker = (id: number) => event(id, 'ADAPTER_INVOCATION_STARTED');
const notSent = (id: number, classification = 'NOT_SENT_PRE_DISPATCH') => event(id, 'NOT_SENT_EVIDENCE_RECORDED', { classification });
const outcome = (id: number, classification: string, extra: Record<string, unknown> = {}) => event(id, 'DISPATCH_OUTCOME_RECORDED', { classification, source: 'WORKER', ...extra });

describe('entry delivery evidence', () => {
  it('pairs every adapter invocation with its own closing record and treats an unclosed one as unknown', () => {
    const closed = summarizeDeliveryEvidence([claimed(1), marker(2), notSent(3, 'NOT_SENT_LOCAL_BLOCKED')]);
    expect(closed).toMatchObject({ adapterMarkers: 1, markerProtocol: true, ambiguous: [] });
    // A later attempt that crashed after its marker is unknown, even though the first was closed.
    const crashed = summarizeDeliveryEvidence([claimed(1), marker(2), notSent(3, 'NOT_SENT_LOCAL_BLOCKED'), marker(4)]);
    expect(crashed.ambiguous).toEqual([expect.objectContaining({ kind: 'UNPAIRED_ADAPTER_MARKER', classification: 'DISPATCH_OUTCOME_UNKNOWN', eventId: 4 })]);
  });

  it('reads legacy uncertainty and inferred outcomes conservatively', () => {
    const summary = summarizeDeliveryEvidence([
      event(1, 'BROKER_DELIVERY_UNCERTAIN', { classification: 'UNCLASSIFIED_AFTER_BROKER_BOUNDARY' }),
      event(2, 'DISPATCH_OUTCOME_RECORDED', { classification: 'DISPATCH_OUTCOME_UNKNOWN', source: 'TERMINAL_CLAIM_SWEEP' }),
      outcome(3, 'BROKER_REJECTED', { statusCode: 409 }),
    ]);
    expect(summary.outcomes.map((item) => [item.classification, item.observation, item.adapterInvocation])).toEqual([
      ['DELIVERY_UNCERTAIN', 'OBSERVED', 'UNKNOWN'],
      ['DISPATCH_OUTCOME_UNKNOWN', 'INFERRED', 'UNKNOWN'],
      ['BROKER_REJECTED', 'OBSERVED', 'HTTP_RESPONSE_RECEIVED'],
    ]);
    expect(summary.adapterRequestObserved).toBe(true);
  });

  it.each([
    ['ENTRY_PENDING never reached the boundary', 'ENTRY_PENDING', [], null, true],
    ['recorded not-sent evidence', 'ENTRY_SUBMITTING', [claimed(1), notSent(2)], null, true],
    ['ENTRY_SUBMITTING without recorded evidence', 'ENTRY_SUBMITTING', [claimed(1)], null, false],
    ['an HTTP 408 response', 'ENTRY_SUBMITTING', [claimed(1), marker(2), outcome(3, 'BROKER_REJECTED', { statusCode: 408 })], null, false],
    ['a definitive 422 response', 'ENTRY_SUBMITTING', [claimed(1), marker(2), outcome(3, 'BROKER_REJECTED', { statusCode: 422 })], null, false],
    ['an unclosed adapter invocation', 'ENTRY_SUBMITTING', [claimed(1), marker(2), notSent(3)].slice(0, 2), null, false],
    ['an uncertain block reason', 'ENTRY_SUBMITTING', [claimed(1), notSent(2)], 'BROKER_WRITE_DELIVERY:DELIVERY_UNCERTAIN:timeout', false],
    ['a pending claim with a marker', 'ENTRY_PENDING', [marker(1)], null, false],
  ] as const)('never-submitted release with %s', (_label, claimStatus, events, blockReason, proven) => {
    expect(evaluateNeverSubmittedRelease({ claimStatus, summary: summarizeDeliveryEvidence([...events]), blockReason }).proven).toBe(proven);
  });

  it('never replaces stronger delivery uncertainty in a block reason', () => {
    expect(preserveBlockReason('BROKER_WRITE_DELIVERY:BROKER_REJECTED:status 409', 'Recovery confirmed no broker order')).toBe('BROKER_WRITE_DELIVERY:BROKER_REJECTED:status 409');
    expect(preserveBlockReason('Daily entry order limit reached.', 'STALE_SUBMISSION_OUTCOME_UNKNOWN: x')).toBe('STALE_SUBMISSION_OUTCOME_UNKNOWN: x');
  });
});

describe('terminal entry claim recovery classification', () => {
  const candidate = (overrides: Partial<TerminalClaimCandidate> & { intent?: Partial<TerminalClaimCandidate['orderIntent']> } = {}): TerminalClaimCandidate => {
    const { intent, ...rest } = overrides;
    return {
      id: 1, status: 'ENTRY_SUBMITTING', tradingAccountId: 1, securityId: 2, symbol: 'SPY', lastDiagnosedAt: null, trackedPositionId: null,
      liveArmingConsumed: false, events: [],
      orderIntent: {
        id: 3, status: 'failed', clientOrderId: 'c-3', blockReason: null, rawRequestJson: {},
        consumptionId: null, dispatchDecisionId: null, dispatchDecisionOutcome: null, unenforcedDispatchId: null, unenforcedDispatchBasis: null,
        dispatchOpportunityEvents: 0, brokerOrders: 0, ...intent,
      },
      ...rest,
    };
  };
  const now = new Date(at.getTime() + 3_600_000);

  it.each([
    ['proven pre-dispatch (structured evidence)', candidate({ events: [claimed(1), notSent(2)] }), 'AUTOMATIC_NEVER_SUBMITTED_RELEASE'],
    ['proven pre-dispatch (claim never submitting)', candidate({ status: 'ENTRY_PENDING' }), 'AUTOMATIC_NEVER_SUBMITTED_RELEASE'],
    ['protocol claim without an adapter marker', candidate({ events: [claimed(1)] }), 'AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING'],
    ['legacy code-classified local non-send', candidate({ intent: { blockReason: 'LOCAL_PRE_DISPATCH_FAILURE:db' } }), 'AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING'],
    ['legacy structured risk evaluation', candidate({ intent: { status: 'blocked', blockReason: 'limit', rawRequestJson: { riskEvaluation: { allowed: false, reason: 'limit' } } } }), 'AUTOMATIC_NOT_SENT_EVIDENCE_RECORDING'],
    ['legacy free text', candidate({ intent: { blockReason: 'connection reset' } }), 'AUTOMATIC_OUTCOME_RECORDING'],
    ['a dispatch record without an outcome', candidate({ intent: { consumptionId: 9 } }), 'AUTOMATIC_OUTCOME_RECORDING'],
    ['a consumed LIVE arming without an outcome', candidate({ liveArmingConsumed: true }), 'AUTOMATIC_OUTCOME_RECORDING'],
    ['an UNRESOLVED definitive rejection', candidate({ status: 'UNRESOLVED', events: [claimed(1), marker(2), outcome(3, 'BROKER_REJECTED', { statusCode: 422 })] }), 'AUTOMATIC_VERIFIED_RELEASE'],
    ['an UNRESOLVED claim with structured not-sent evidence', candidate({ status: 'UNRESOLVED', events: [claimed(1), notSent(2)] }), 'AUTOMATIC_VERIFIED_RELEASE'],
    ['an UNRESOLVED 408', candidate({ status: 'UNRESOLVED', events: [claimed(1), marker(2), outcome(3, 'BROKER_REJECTED', { statusCode: 408 })] }), 'OPERATOR_INVESTIGATION'],
    ['an UNRESOLVED 409', candidate({ status: 'UNRESOLVED', events: [claimed(1), marker(2), outcome(3, 'BROKER_REJECTED', { statusCode: 409 })] }), 'OPERATOR_INVESTIGATION'],
    ['an UNRESOLVED uncertain delivery', candidate({ status: 'UNRESOLVED', events: [claimed(1), marker(2), outcome(3, 'DELIVERY_UNCERTAIN')] }), 'OPERATOR_INVESTIGATION'],
    ['an UNRESOLVED claim with no evidence', candidate({ status: 'UNRESOLVED' }), 'OPERATOR_INVESTIGATION'],
    ['a local broker order', candidate({ status: 'UNRESOLVED', intent: { brokerOrders: 1 } }), 'PROTECTED_EXPOSURE'],
    ['an attached position', candidate({ status: 'UNRESOLVED', trackedPositionId: 4 }), 'PROTECTED_EXPOSURE'],
  ] as const)('classifies %s', (_label, value, state) => {
    expect(classifyTerminalEntryClaim(value, now).state).toBe(state);
  });

  it('labels an uncertain outcome without a dispatch record or observed request as unknown, not uncertain delivery', () => {
    const inferred = candidate({ status: 'UNRESOLVED', events: [event(1, 'DISPATCH_OUTCOME_RECORDED', { classification: 'DISPATCH_OUTCOME_UNKNOWN', source: 'TERMINAL_CLAIM_SWEEP' })] });
    expect(classifyTerminalEntryClaim(inferred, now)).toMatchObject({ state: 'OPERATOR_INVESTIGATION', blocker: 'DELIVERY_OUTCOME_UNKNOWN_NO_DISPATCH_RECORD' });
  });
});

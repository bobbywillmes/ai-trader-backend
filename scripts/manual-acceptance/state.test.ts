import { describe, expect, it, vi } from 'vitest';

import { buildManualAcceptanceState } from './state.js';

const now = new Date('2026-08-17T20:00:00.000Z');

function accountState(state: 'initial' | 'staged' | 'armed' | 'consumed' | 'disarmed') {
  const hasArming = ['armed', 'consumed', 'disarmed'].includes(state);
  const active = state === 'armed';
  const terminations = state === 'consumed'
    ? [{ type: 'CONSUMED', reason: 'Consumed by entry.', orderIntentId: 41, clientOrderId: 'acceptance-41', occurredAt: now }]
    : state === 'disarmed'
      ? [{ type: 'DISARMED', reason: 'Operator disarmed.', orderIntentId: null, clientOrderId: null, occurredAt: now }]
      : [];
  return {
    id: 1,
    status: 'ACTIVE',
    tradingEnabled: active,
    killSwitchEnabled: !active,
    activeLiveEntryArmingId: active ? 9 : null,
    accountSubscriptions: [{
      id: 3,
      enabled: true,
      entriesEnabled: state !== 'initial' && state !== 'disarmed',
      exitsEnabled: true,
      subscription: { key: 'rsp_dip_core' },
    }],
    liveEntryArmings: hasArming ? [{
      id: 9,
      entryApprovalId: 7,
      entryApprovalRevision: 1,
      riskReducingApprovalId: 6,
      riskReducingApprovalRevision: 1,
      tradingAccountSubscriptionId: 3,
      armedAt: now,
      terminations,
    }] : [],
  };
}

function approvals(entryPresent: boolean) {
  return {
    capabilities: [
      { capability: 'RISK_REDUCING', effective: true, reason: null, approval: { status: 'GRANTED', revision: 1, expiresAt: null } },
      { capability: 'ENTRY', effective: entryPresent, reason: entryPresent ? null : 'MISSING', approval: entryPresent ? { status: 'GRANTED', revision: 1, expiresAt: new Date('2026-08-17T23:59:00.000Z') } : null },
    ],
  };
}

describe('manual acceptance state diagnostic', () => {
  it.each([
    ['initial', 'AVAILABLE_NONE'],
    ['staged', 'AVAILABLE_NONE'],
    ['armed', 'AVAILABLE'],
    ['consumed', 'CONSUMED'],
    ['disarmed', 'TERMINATED'],
  ] as const)('serializes the %s ceremony state without side effects', async (state, oneShotStatus) => {
    const findFirst = vi.fn().mockResolvedValue(accountState(state));
    const mutate = vi.fn();
    const disconnect = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await buildManualAcceptanceState({
      db: { tradingAccount: { findFirst }, update: mutate, $disconnect: disconnect } as never,
      getApprovalState: vi.fn().mockResolvedValue(approvals(!['initial', 'staged'].includes(state))),
      getTransportState: () => ({ totalRequests: 2, getCount: 2, postCount: 0, recentRequests: [{ method: 'GET', occurredAt: now.toISOString() }] }),
    });

    expect(result.account.status).toBe('ACTIVE');
    expect(result.canaryAssignment?.subscription.key).toBe('rsp_dip_core');
    expect(result.approvals.riskReducing).toMatchObject({ storedStatus: 'GRANTED', effective: true, revision: 1 });
    expect(result.approvals.entry.storedStatus).toBe(['initial', 'staged'].includes(state) ? 'MISSING' : 'GRANTED');
    if (oneShotStatus === 'AVAILABLE_NONE') expect(result.arming).toBeNull();
    else expect(result.arming?.oneShotStatus).toBe(oneShotStatus);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(findFirst).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns a compact mock ledger and consumption evidence', async () => {
    const result = await buildManualAcceptanceState({
      db: { tradingAccount: { findFirst: vi.fn().mockResolvedValue(accountState('consumed')) } },
      getApprovalState: vi.fn().mockResolvedValue(approvals(true)),
      getTransportState: () => ({ totalRequests: 4, getCount: 3, postCount: 1, recentRequests: [{ method: 'POST', path: '/v2/orders' }] }),
    });
    expect(result.mockTransport).toMatchObject({ totalRequests: 4, getCount: 3, postCount: 1 });
    expect(result.arming?.consumption).toMatchObject({ orderIntentId: 41, clientOrderId: 'acceptance-41' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), approvals: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { tradingAccount: { findMany: mocks.findMany } } }));
vi.mock('./live-write-approval.service.js', () => ({ getLiveWriteApprovalState: mocks.approvals }));

import { getLiveOperations } from './live-operations.service.js';

const now = new Date('2026-08-25T20:00:00Z');
function worker(workerKey: string, overrides = {}) { return { workerKey, applicable: true, eligible: true, currentRunStartedAt: null, lastSucceededAt: new Date('2026-08-25T19:59:50Z'), lastTickCompletedAt: new Date('2026-08-25T19:59:50Z'), lastFailedAt: null, consecutiveFailures: 0, backoffUntil: null, lastLockSkippedAt: null, totalLockSkips: 0, createdAt: new Date('2026-08-25T19:00:00Z'), lastError: null, lastSkipReason: null, lastSummaryJson: workerKey === 'scheduled_reconciliation' ? { findingCount: 0 } : {}, ...overrides }; }
function account(overrides: Record<string, unknown> = {}) {
  return { id: 7, displayName: 'Bobby Live', broker: 'ALPACA', environment: 'LIVE', status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArming: null,
    trackedPositions: [{ id: 41, symbol: 'RSP', qty: 4, avgEntryPrice: 221.30, status: 'open', lastSyncedAt: new Date('2026-08-25T19:59:50Z'), subscriptionId: 3, subscription: { key: 'rsp_dip_core', exitProfile: { id: 4, key: 'rsp_exit', name: 'RSP exit', exitMode: 'unlock_trailing_stop' } }, tradingAccountSubscription: { id: 8, subscriptionId: 3, enabled: true, exitsEnabled: true, subscription: { key: 'rsp_dip_core', exitProfile: { id: 4, key: 'rsp_exit', name: 'RSP exit', exitMode: 'unlock_trailing_stop' } } }, exitState: { targetUnlocked: false, trailBrokerOrderId: null, attentionRequired: false, attentionMessage: null, attentionCode: null }, orderIntents: [] }],
    workerHealthStates: ['tracked_position_sync','exit_evaluation','broker_activity_sync','submitted_order_sync','scheduled_reconciliation'].map((key) => worker(key)), liveEntryAcceptanceRuns: [{ id: 2, terminalAt: now }], ...overrides };
}
function approvals(risk = true) { return { capabilities: [{ capability: 'RISK_REDUCING', effective: risk }, { capability: 'ENTRY', effective: false }] }; }

describe('Live operational state', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.approvals.mockResolvedValue(approvals()); });
  it('derives healthy open exposure and expected disarmed entry posture', async () => { mocks.findMany.mockResolvedValue([account()]); const result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now); expect(result.summary.openPositionCount).toBe(1); expect(result.accounts[0]?.entryPosture.state).toBe('DISARMED'); expect(result.accounts[0]?.positions[0]?.expectation).toContain('No exit order'); });
  it('keeps mixed account states isolated', async () => { mocks.findMany.mockResolvedValue([account(), account({ id: 8, displayName: 'Second Live', trackedPositions: [{ ...account().trackedPositions[0], id: 42, tradingAccountSubscription: null }] })]); const result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now); expect(result.accounts.map((item) => item.health)).toEqual(['HEALTHY', 'ACTION_REQUIRED']); expect(result.summary.accountsRequiringAttention).toBe(1); });
  it('treats no exposure and inactive risk authorization as non-failing', async () => { mocks.findMany.mockResolvedValue([account({ trackedPositions: [] })]); mocks.approvals.mockResolvedValue(approvals(false)); const result = await getLiveOperations({ userId: 1, role: 'OPERATOR' }, now); expect(result.accounts[0]?.exitCapability.state).toBe('NOT_APPLICABLE'); expect(result.accounts[0]?.nextOperatorAction.code).not.toBe('ATTENTION_REQUIRED'); });
  it('requires action for unattributed exposure', async () => { const position = { ...account().trackedPositions[0], tradingAccountSubscription: null }; mocks.findMany.mockResolvedValue([account({ trackedPositions: [position] })]); const result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now); expect(result.accounts[0]?.health).toBe('ACTION_REQUIRED'); expect(result.accounts[0]?.positions[0]?.attentionReasons[0]).toContain('attribution'); });
  it('never labels stale exit evidence healthy', async () => {
    const workerHealthStates = account().workerHealthStates.map((item: { workerKey: string }) =>
      item.workerKey === 'exit_evaluation'
        ? worker(item.workerKey, { lastSucceededAt: new Date('2026-08-20T00:00:00Z'), lastTickCompletedAt: new Date('2026-08-20T00:00:00Z') })
        : item
    );
    mocks.findMany.mockResolvedValue([account({ workerHealthStates })]);
    const result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now);
    expect(result.accounts[0]?.positions[0]?.exitEvaluation.freshness).not.toBe('CURRENT');
    expect(result.accounts[0]?.health).not.toBe('HEALTHY');
  });
  it('surfaces reconciliation discrepancies', async () => {
    const workerHealthStates = account().workerHealthStates.map((item: { workerKey: string }) =>
      item.workerKey === 'scheduled_reconciliation'
        ? worker(item.workerKey, { lastSummaryJson: { findingCount: 2 } })
        : item
    );
    mocks.findMany.mockResolvedValue([account({ workerHealthStates })]);
    const result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now);
    expect(result.accounts[0]?.reconciliation.health).toBe('ACTION_REQUIRED');
  });
  it('distinguishes missing authorization with and without an action due', async () => { mocks.approvals.mockResolvedValue(approvals(false)); mocks.findMany.mockResolvedValue([account()]); let result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now); expect(result.accounts[0]?.positions[0]?.attentionReasons.join(' ')).not.toContain('waiting without'); const due = { ...account().trackedPositions[0], status: 'closing' }; mocks.findMany.mockResolvedValue([account({ trackedPositions: [due] })]); result = await getLiveOperations({ userId: 1, role: 'SYSTEM_OWNER' }, now); expect(result.accounts[0]?.health).toBe('ACTION_REQUIRED'); expect(result.accounts[0]?.positions[0]?.attentionReasons.join(' ')).toContain('waiting without'); });
  it('passes account and membership filters to the database', async () => { mocks.findMany.mockResolvedValue([]); await getLiveOperations({ userId: 9, role: 'OPERATOR', tradingAccountId: 12 }, now); expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 12, environment: 'LIVE', memberships: { some: { userId: 9 } } }) })); });
});

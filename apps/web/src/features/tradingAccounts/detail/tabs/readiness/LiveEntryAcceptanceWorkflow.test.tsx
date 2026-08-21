// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountSubscription } from '../../../types';

const mutation = { mutate: vi.fn(), isPending: false, error: null };
const mocks = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../../hooks', () => ({
  useCurrentLiveEntryAcceptance: () => ({ data: { run: mocks.current } }),
  useCreateLiveEntryAcceptance: () => mutation,
  usePreviewLiveEntryAcceptance: () => mutation,
  useExecuteLiveEntryAcceptance: () => mutation,
  useVerifyLiveEntryAcceptance: () => mutation,
  useAbortLiveEntryAcceptance: () => mutation,
}));

const executionProjection = {
    phase: 'EXECUTION', unresolved: false,
    setup: { ready: true, accountActive: true, assignmentMatches: true, canaryStaged: true }, authorization: { ready: true }, readiness: { ready: true },
    execution: { claimed: false, uncertain: false, previewFrozen: false },
    run: {
      id: 9, tradingAccountSubscriptionId: 8, subscriptionId: 3, securityId: 4,
      previewRevision: 2, previewFingerprint: 'a'.repeat(64), executionClaimedAt: null,
      executionUncertainAt: null, executionFailureJson: null, terminalOutcome: null,
      terminalReason: null, terminalEvidenceJson: null, terminalAt: null, orderIntent: null,
      tradingAccountSubscription: { id: 8, subscriptionId: 3, enabled: true, entriesEnabled: true, exitsEnabled: true, subscription: { key: 'rsp_dip_core' } },
      previewJson: {
        environment: 'LIVE',
        order: { symbol: 'RSP', side: 'buy', qty: 4, orderType: 'market', timeInForce: 'day', referencePrice: 250, referencePriceAt: '2026-08-20T17:00:00Z', referencePriceSource: 'alpaca_latest_trade', estimatedNotional: 1000 },
        arming: { id: 7, expiresAt: '2026-08-20T20:00:00Z' },
      },
    },
  };

const completedProjection = {
  ...executionProjection,
  phase: 'COMPLETION',
  execution: { claimed: true, uncertain: false, previewFrozen: true },
  run: {
    ...executionProjection.run,
    executionClaimedAt: '2026-08-21T14:01:00.000Z',
    terminalOutcome: 'CANARY_COMPLETE',
    terminalReason: 'The Live-entry canary and all required safety invariants were verified.',
    terminalAt: '2026-08-21T14:03:12.778Z',
    terminalEvidenceJson: {
      activeArmingAbsent: true,
      lifecycleHealthy: true,
      reconciliationRunIdentifier: 'reconciliation-run-1',
      relevantReconciliationFindings: [],
    },
    tradingAccount: {
      id: 1, displayName: 'Bobby Live', environment: 'LIVE', status: 'ACTIVE',
      tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArmingId: null,
    },
    tradingAccountSubscription: {
      id: 8, subscriptionId: 3, enabled: true, entriesEnabled: false, exitsEnabled: true, subscription: { key: 'rsp_dip_core' },
    },
    liveEntryArming: {
      id: 7,
      entryApprovalExpiresAt: '2026-08-21T14:10:00.000Z',
      terminations: [{
        id: 1, type: 'CONSUMED', reason: 'Consumed before outbound submission.',
        orderIntentId: 1, clientOrderId: 'ai-accept-run1-rev1', occurredAt: '2026-08-21T14:01:08.339Z',
      }],
    },
    orderIntent: {
      id: 1, status: 'filled', clientOrderId: 'ai-accept-run1-rev1',
      brokerOrders: [{ id: 1, brokerOrderId: 'mock-order-1', clientOrderId: 'ai-accept-run1-rev1', status: 'filled' }],
      brokerActivities: [{ id: 1, activityId: 'fill-mock-order-1', activityType: 'FILL', qty: 4, cumQty: 4, price: 250, orderId: 'mock-order-1', transactionTime: '2026-08-21T14:01:08.352Z' }],
      trackedPosition: {
        id: 1, status: 'open', qty: 4, avgEntryPrice: 250, subscriptionId: 3, tradingAccountSubscriptionId: 8,
        exitState: { status: 'watching', attentionRequired: false, attentionCode: null },
      },
    },
  },
};

import { LiveEntryAcceptanceWorkflow } from './LiveEntryAcceptanceWorkflow';

describe('LiveEntryAcceptanceWorkflow', () => {
  afterEach(() => { cleanup(); mocks.current = null; });

  it('shows the exact reviewed Live order and one-shot consumption warning', () => {
    mocks.current = executionProjection;
    const account = { id: 1, displayName: 'Bobby Live', activeLiveEntryArmingId: 7 } as TradingAccount;
    const assignment = { id: 8 } as TradingAccountSubscription;
    render(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);

    expect(screen.getByText('LIVE', { selector: 'b' })).toBeTruthy();
    expect(screen.getByText('BUY 4 RSP')).toBeTruthy();
    expect(screen.getByText('MARKET / DAY')).toBeTruthy();
    expect(screen.getByText('rsp_dip_core (#8)')).toBeTruthy();
    expect(screen.getByText('$250.00')).toBeTruthy();
    expect(screen.getByText('$1,000.00')).toBeTruthy();
    expect(screen.getByText(/alpaca_latest_trade/)).toBeTruthy();
    expect(screen.getByText(/One-shot Live entry authority is consumed transactionally before outbound submission/)).toBeTruthy();
    expect(screen.getByLabelText('Type BUY RSP')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit real broker order' }).hasAttribute('disabled')).toBe(true);
  });

  it('labels the guarded harness preview as synthetic without weakening confirmation', () => {
    mocks.current = executionProjection;
    render(<MantineProvider><LiveEntryAcceptanceWorkflow
      account={{ id: 1, displayName: 'Synthetic Live Acceptance', activeLiveEntryArmingId: 7 } as TradingAccount}
      assignment={{ id: 8 } as TradingAccountSubscription}
      token="token"
      manualAcceptanceHarness
    /></MantineProvider>);

    expect(screen.getByText('SYNTHETIC BROKER-ISOLATED ORDER')).toBeTruthy();
    expect(screen.getByText(/Outbound broker traffic is intercepted and no real Alpaca order can leave/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit intercepted synthetic order' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Type BUY RSP')).toBeTruthy();
  });

  it('makes the durable ceremony canonical and explains observation-only blocking', () => {
    mocks.current = {
      ...executionProjection,
      phase: 'SETUP',
      setup: { ready: false, accountActive: false, assignmentMatches: true, canaryStaged: false },
      authorization: { ready: false },
      readiness: { ready: false },
      run: { ...executionProjection.run, previewJson: null, previewRevision: 0, previewFingerprint: null },
    };
    const prerequisiteState = {
      nextAction: 'Grant RISK_REDUCING authorization from the current Live Activation assessment.',
      milestones: [
        { key: 'risk', label: 'RISK_REDUCING effective', status: 'NEXT' as const },
        { key: 'activated', label: 'Account activated with entries disarmed', status: 'PENDING' as const },
      ],
    } as never;
    const account = { id: 1, displayName: 'Bobby Live', status: 'PAUSED' } as TradingAccount;
    const assignment = { id: 8 } as TradingAccountSubscription;

    render(<MantineProvider><LiveEntryAcceptanceWorkflow
      account={account}
      assignment={assignment}
      token="token"
      prerequisiteState={prerequisiteState}
      deploymentRole="OBSERVATION_ONLY"
    /></MantineProvider>);

    expect(screen.getByTestId('acceptance-current-guidance')).toBeTruthy();
    expect(screen.getByText('Observation-only deployment')).toBeTruthy();
    expect(screen.getByText(/No hidden button or manual backend action is required/)).toBeTruthy();
    expect(screen.getByText(/manual-acceptance harness/)).toBeTruthy();
    expect(screen.getByText('CURRENT BLOCKER')).toBeTruthy();
    expect(screen.queryByText('Live Entry Setup Progress')).toBeNull();
  });

  it('keeps a completed run and its authoritative evidence visible after verification refetch', () => {
    mocks.current = { ...executionProjection, phase: 'VERIFICATION', run: { ...completedProjection.run, terminalOutcome: null, terminalReason: null, terminalAt: null } };
    const account = { id: 1, displayName: 'Bobby Live', activeLiveEntryArmingId: null } as TradingAccount;
    const assignment = { id: 8 } as TradingAccountSubscription;
    const view = render(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);

    mocks.current = completedProjection;
    view.rerender(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);

    expect(screen.getByTestId('acceptance-terminal-summary')).toBeTruthy();
    expect(screen.getByText('CANARY COMPLETE', { selector: 'h4' })).toBeTruthy();
    expect(screen.getAllByText(/mock-order-1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/fill-mock-order-1/)).toBeTruthy();
    expect(screen.getByText(/subscription #3, assignment #8/)).toBeTruthy();
    expect(screen.getByText(/Reconciliation run:/).textContent).toContain('reconciliation-run-1');
    expect(screen.queryByText('NOT STARTED')).toBeNull();
    expect(screen.getAllByText('DONE')).toHaveLength(7);
  });

  it('reconstructs the same terminal summary on a full component reload', () => {
    mocks.current = completedProjection;
    const account = { id: 1, displayName: 'Bobby Live' } as TradingAccount;
    const assignment = { id: 8 } as TradingAccountSubscription;
    const first = render(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);
    first.unmount();
    render(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);

    expect(screen.getAllByText(/all required safety invariants were verified/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Account trading disabled:/).textContent).toContain('yes');
    expect(screen.getByText(/Kill switch enabled:/).textContent).toContain('yes');
    expect(screen.getByText(/Assignment entries disabled:/).textContent).toContain('yes');
  });

  it('keeps ACTION_REQUIRED visible while execution remains unresolved', () => {
    mocks.current = {
      ...completedProjection,
      phase: 'ACTION_REQUIRED', unresolved: true,
      run: { ...completedProjection.run, terminalOutcome: null, terminalReason: null, terminalAt: null, executionUncertainAt: '2026-08-21T14:02:00.000Z' },
    };
    render(<MantineProvider><LiveEntryAcceptanceWorkflow account={{ id: 1 } as TradingAccount} assignment={{ id: 8 } as TradingAccountSubscription} token="token" /></MantineProvider>);

    expect(screen.getAllByText('ACTION REQUIRED').length).toBeGreaterThan(0);
    expect(screen.getByText(/blocks re-arming and replacement ceremonies/)).toBeTruthy();
    expect(screen.queryByText('NOT STARTED')).toBeNull();
  });

  it('uses NOT STARTED only for a pristine account with no run', () => {
    mocks.current = null;
    render(<MantineProvider><LiveEntryAcceptanceWorkflow account={{ id: 1 } as TradingAccount} assignment={{ id: 8 } as TradingAccountSubscription} token="token" /></MantineProvider>);

    expect(screen.getByText('NOT STARTED')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start acceptance run' })).toBeTruthy();
  });
});

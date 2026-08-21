// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountSubscription } from '../../../types';

const mutation = { mutate: vi.fn(), isPending: false, error: null };
const mocks = vi.hoisted(() => ({
  current: null as unknown,
  createPayload: null as unknown,
  history: [] as unknown[],
  details: {} as Record<number, unknown>,
}));
vi.mock('../../../hooks', () => ({
  useCurrentLiveEntryAcceptance: () => ({ data: { run: mocks.current } }),
  useLiveEntryAcceptanceHistory: () => ({ data: { runs: mocks.history }, isLoading: false }),
  useLiveEntryAcceptanceDetail: (_id: number, runId: number | null) => ({ data: runId ? mocks.details[runId] : undefined, isLoading: false }),
  useCreateLiveEntryAcceptance: (_id: number, _token: string | null, payload: unknown) => {
    mocks.createPayload = payload;
    return mutation;
  },
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
      createdAt: '2026-08-21T11:00:00.000Z', updatedAt: '2026-08-21T11:00:00.000Z',
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
  afterEach(() => {
    cleanup(); mocks.current = null; mocks.createPayload = null; mocks.history = []; mocks.details = {}; vi.clearAllMocks();
  });

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

  it('keeps terminal Run 1 visible while offering a fresh-reason transition to Run 2', () => {
    const terminalRun1 = {
      ...completedProjection,
      run: {
        ...completedProjection.run,
        id: 9,
        executionClaimedAt: null,
        terminalOutcome: 'OPERATOR_ABORTED',
        terminalReason: 'Production rehearsal stopped before execution.',
        orderIntent: null,
        liveEntryArming: null,
      },
    };
    mocks.current = terminalRun1;
    const account = { id: 1, displayName: 'Bobby Live' } as TradingAccount;
    const assignment = { id: 8 } as TradingAccountSubscription;
    const view = render(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);

    expect(screen.getAllByText(/Run #9/).length).toBeGreaterThan(0);
    expect(screen.getByText('OPERATOR ABORTED', { selector: 'h4' })).toBeTruthy();
    const start = screen.getByRole('button', { name: 'Start new acceptance run' });
    expect(start.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('New acceptance run reason'), { target: { value: 'Real production canary Run 2' } });
    expect(start.hasAttribute('disabled')).toBe(false);
    expect(mocks.createPayload).toEqual({ tradingAccountSubscriptionId: 8, reason: 'Real production canary Run 2' });
    fireEvent.click(start);
    expect(mutation.mutate).toHaveBeenCalledTimes(1);

    mocks.current = {
      ...executionProjection,
      phase: 'SETUP',
      run: { ...executionProjection.run, id: 10, previewJson: null, previewRevision: 0, previewFingerprint: null },
    };
    view.rerender(<MantineProvider><LiveEntryAcceptanceWorkflow account={account} assignment={assignment} token="token" /></MantineProvider>);
    expect(screen.getByText(/Run #10/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start new acceptance run' })).toBeNull();
    expect(screen.queryByText('NOT STARTED')).toBeNull();
  });

  it('shows canonical Run 2 with historical OPERATOR_ABORTED Run 1 evidence', () => {
    const run2 = { ...executionProjection, phase: 'SETUP', run: { ...executionProjection.run, id: 10, previewJson: null, previewRevision: 0, previewFingerprint: null } };
    const run1 = {
      ...completedProjection,
      run: {
        ...completedProjection.run,
        id: 9,
        reason: 'Production rehearsal',
        terminalOutcome: 'OPERATOR_ABORTED',
        terminalReason: 'Stopped before the real canary.',
        terminalEvidenceJson: { cleanup: { attentionRequired: false }, enabledEntryAssignmentCount: 0 },
        executionClaimedAt: null,
        orderIntent: null,
        liveEntryArming: null,
      },
    };
    mocks.current = run2;
    mocks.history = [run2, run1];
    mocks.details = { 9: run1 };
    render(<MantineProvider><LiveEntryAcceptanceWorkflow account={{ id: 1 } as TradingAccount} assignment={{ id: 8 } as TradingAccountSubscription} token="token" /></MantineProvider>);

    expect(screen.getByText(/Run #10/)).toBeTruthy();
    expect(screen.getByTestId('acceptance-history')).toBeTruthy();
    expect(screen.getByText('OPERATOR ABORTED', { selector: 'td' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect Run #9' }));
    expect(screen.getByTestId('acceptance-history-detail')).toBeTruthy();
    expect(screen.getByText('Run #9 authoritative detail')).toBeTruthy();
    expect(screen.getAllByText(/Stopped before the real canary/)).toHaveLength(2);
    expect(screen.getByText(/enabledEntryAssignmentCount/)).toBeTruthy();
  });

  it('opens historical CANARY_COMPLETE broker and position evidence', () => {
    const currentRun = { ...executionProjection, phase: 'SETUP', run: { ...executionProjection.run, id: 10, previewJson: null, previewRevision: 0, previewFingerprint: null } };
    const completedRun = { ...completedProjection, run: { ...completedProjection.run, id: 8 } };
    mocks.current = currentRun;
    mocks.history = [currentRun, completedRun];
    mocks.details = { 8: completedRun };
    render(<MantineProvider><LiveEntryAcceptanceWorkflow account={{ id: 1 } as TradingAccount} assignment={{ id: 8 } as TradingAccountSubscription} token="token" /></MantineProvider>);

    fireEvent.click(screen.getByRole('button', { name: 'Inspect Run #8' }));
    expect(screen.getByText('CANARY COMPLETE', { selector: 'b' })).toBeTruthy();
    expect(screen.getByText(/mock-order-1/)).toBeTruthy();
    expect(screen.getByText(/TrackedPosition:/).textContent).toContain('#1');
    expect(screen.getByText(/reconciliationRunIdentifier/)).toBeTruthy();
  });

  it('reconstructs current and historical runs after a browser reload', () => {
    const run2 = { ...executionProjection, phase: 'SETUP', run: { ...executionProjection.run, id: 10, previewJson: null, previewRevision: 0, previewFingerprint: null } };
    const run1 = { ...completedProjection, run: { ...completedProjection.run, id: 9, terminalOutcome: 'OPERATOR_ABORTED', terminalReason: 'Stopped.' } };
    mocks.current = run2;
    mocks.history = [run2, run1];
    const props = { account: { id: 1 } as TradingAccount, assignment: { id: 8 } as TradingAccountSubscription, token: 'token' };
    const first = render(<MantineProvider><LiveEntryAcceptanceWorkflow {...props} /></MantineProvider>);
    first.unmount();
    render(<MantineProvider><LiveEntryAcceptanceWorkflow {...props} /></MantineProvider>);

    expect(screen.getByText(/Run #10/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inspect Run #9' })).toBeTruthy();
  });

  it('moves Run 2 into history beside Run 1 when Run 3 becomes canonical', () => {
    const run1 = { ...completedProjection, run: { ...completedProjection.run, id: 9, terminalOutcome: 'OPERATOR_ABORTED', terminalReason: 'Stopped.' } };
    const run2Terminal = { ...completedProjection, run: { ...completedProjection.run, id: 10, terminalOutcome: 'FAILED_SAFE', terminalReason: 'No broker submission occurred.' } };
    const run2Current = { ...executionProjection, phase: 'SETUP', run: { ...executionProjection.run, id: 10, previewJson: null, previewRevision: 0, previewFingerprint: null } };
    mocks.current = run2Current;
    mocks.history = [run2Current, run1];
    const props = { account: { id: 1 } as TradingAccount, assignment: { id: 8 } as TradingAccountSubscription, token: 'token' };
    const view = render(<MantineProvider><LiveEntryAcceptanceWorkflow {...props} /></MantineProvider>);

    const run3 = { ...executionProjection, phase: 'SETUP', run: { ...executionProjection.run, id: 11, previewJson: null, previewRevision: 0, previewFingerprint: null } };
    mocks.current = run3;
    mocks.history = [run3, run2Terminal, run1];
    view.rerender(<MantineProvider><LiveEntryAcceptanceWorkflow {...props} /></MantineProvider>);

    expect(screen.getByText(/Run #11/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inspect Run #10' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inspect Run #9' })).toBeTruthy();
    expect(screen.getByText('2 PRIOR')).toBeTruthy();
  });
});

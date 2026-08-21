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
      previewJson: {
        environment: 'LIVE',
        order: { symbol: 'RSP', side: 'buy', qty: 4, orderType: 'market', timeInForce: 'day', referencePrice: 250, referencePriceAt: '2026-08-20T17:00:00Z', estimatedNotional: 1000 },
        arming: { id: 7, expiresAt: '2026-08-20T20:00:00Z' },
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
    expect(screen.getByText(/One-shot Live entry authority is consumed transactionally before outbound submission/)).toBeTruthy();
    expect(screen.getByLabelText('Type BUY RSP')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit real broker order' }).hasAttribute('disabled')).toBe(true);
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
});

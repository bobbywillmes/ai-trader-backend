// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountSubscription } from '../../../types';

const mutation = { mutate: vi.fn(), isPending: false, error: null };
vi.mock('../../../hooks', () => ({
  useCurrentLiveEntryAcceptance: () => ({ data: { run: {
    phase: 'EXECUTION', unresolved: false,
    setup: { ready: true, accountActive: true, assignmentMatches: true }, authorization: { ready: true }, readiness: { ready: true },
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
  } } }),
  useCreateLiveEntryAcceptance: () => mutation,
  usePreviewLiveEntryAcceptance: () => mutation,
  useExecuteLiveEntryAcceptance: () => mutation,
  useVerifyLiveEntryAcceptance: () => mutation,
  useAbortLiveEntryAcceptance: () => mutation,
}));

import { LiveEntryAcceptanceWorkflow } from './LiveEntryAcceptanceWorkflow';

describe('LiveEntryAcceptanceWorkflow', () => {
  afterEach(cleanup);

  it('shows the exact reviewed Live order and one-shot consumption warning', () => {
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
});

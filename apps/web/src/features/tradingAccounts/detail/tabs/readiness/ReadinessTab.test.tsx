// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

const mocks = vi.hoisted(() => ({ assessments: [] as TradingAccountReadinessAssessment[] }));
vi.mock('../../../hooks', () => ({
  useLatestTradingAccountReadiness: () => ({ data: { assessment: mocks.assessments[0] ?? null }, isLoading: false }),
  useTradingAccountReadinessHistory: () => ({ data: { assessments: mocks.assessments } }),
  useRunTradingAccountReadiness: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));
vi.mock('./LiveAccountActivationCard', () => ({ LiveAccountActivationCard: () => null }));
vi.mock('./LiveEntryArmingCard', () => ({ LiveEntryArmingCard: () => <div>Live Entry Authority</div> }));
vi.mock('./LiveWriteAuthorizationCard', () => ({ LiveWriteAuthorizationCard: () => null }));

import { AssessmentDetails, ReadinessTab } from './ReadinessTab';

function assessment(id = 1): TradingAccountReadinessAssessment {
  const gate = { code: 'TEST', outcome: 'BLOCKED', message: 'Underlying result remains visible.' } as const;
  return {
    id, tradingAccountId: 1, purpose: 'LIVE_ENTRY_ARMING', result: 'PASSED', validity: 'CURRENT', assessmentVersion: 1,
    startedAt: '2026-08-18T19:00:00Z', completedAt: `2026-08-18T19:0${id}:00Z`, expiresAt: '2026-08-18T19:15:00Z', createdAt: '2026-08-18T19:00:00Z',
    configurationFingerprint: `${id}`.repeat(64), credentialFingerprint: 'b'.repeat(64), policyFingerprint: 'c'.repeat(64), credentialVerifiedAt: '2026-08-18T19:00:00Z',
    accountSnapshotId: null, brokerAccountId: null, brokerAccountStatus: null, tradingBlocked: false, brokerPositionCount: 0, brokerOpenOrderCount: 0,
    localOpenPositionCount: 0, localClosingPositionCount: 0, localNonterminalIntentCount: 0, localNonterminalOrderCount: 0,
    stages: [
      { key: 'ACTIVATION_READY', outcome: 'BLOCKED', summary: 'Activation lifecycle.', gates: [gate], blockerCount: 1, warningCount: 0 },
      { key: 'LIVE_ENTRY_ARMING_READY', outcome: 'PASSED', summary: 'Arming lifecycle.', gates: [], blockerCount: 0, warningCount: 0 },
    ], gates: [gate], blockers: [gate], warnings: [], evidence: {}, reconciliationSummary: null, staleReasons: [],
  };
}

const account = { id: 1, environment: 'LIVE', status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true } as TradingAccount;

describe('Readiness presentation', () => {
  afterEach(() => { cleanup(); mocks.assessments = []; });

  it('makes purpose authoritative while retaining and de-emphasizing unrelated lifecycle results', () => {
    render(<MantineProvider><AssessmentDetails assessment={assessment()} /></MantineProvider>);
    expect(screen.getByText('Assessment purpose: Live Entry Arming')).toBeTruthy();
    expect(screen.getByText('NOT REQUIRED FOR THIS ASSESSMENT')).toBeTruthy();
    expect(screen.getByText('Underlying result remains visible.')).toBeTruthy();
    expect(screen.getByText('Live entry arming ready')).toBeTruthy();
  });

  it('presents Live Activation as authoritative for activation assessments', () => {
    const activation = assessment();
    activation.purpose = 'LIVE_ACTIVATION';
    activation.stages = activation.stages.map((stage) => stage.key === 'LIVE_ENTRY_ARMING_READY' ? { ...stage, key: 'ENTRY_READY' } : stage);
    render(<MantineProvider><AssessmentDetails assessment={activation} /></MantineProvider>);
    expect(screen.getByText('Assessment purpose: Live Activation')).toBeTruthy();
    expect(screen.getByText('Activation ready')).toBeTruthy();
    expect(screen.getByText('NOT REQUIRED FOR THIS ASSESSMENT')).toBeTruthy();
  });

  it('defaults history to five, shows purpose, expands all, and collapses to recent', async () => {
    mocks.assessments = Array.from({ length: 7 }, (_, index) => assessment(index + 1));
    render(<MantineProvider><ReadinessTab account={account} token="token" /></MantineProvider>);
    expect(screen.getByText('Showing latest 5 of 7')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(6);
    expect(screen.getAllByText('Live Entry Arming').length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText('Showing all of 7')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: 'Collapse / Show recent' }));
    expect(screen.getAllByRole('row')).toHaveLength(6);
  });

  it('renders the progress/readiness layout at a mobile viewport', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    mocks.assessments = [assessment()];
    render(<MantineProvider><ReadinessTab account={account} token="token" /></MantineProvider>);
    expect(screen.getByText('Current posture')).toBeTruthy();
    expect(screen.getByText('Live Entry Authority')).toBeTruthy();
  });
});

// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';
import { LiveEntrySetupProgress } from './LiveEntrySetupProgress';

const account = { id: 1, status: 'ACTIVE', tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArmingId: null, credential: {} } as unknown as TradingAccount;
const readiness = { purpose: 'LIVE_ENTRY_ARMING', result: 'PASSED', validity: 'CURRENT', credentialVerifiedAt: '2026-08-18T19:00:00Z' } as TradingAccountReadinessAssessment;

function show(overrides: { account?: TradingAccount; assessment?: TradingAccountReadinessAssessment | null; staged?: boolean; risk?: boolean; entry?: boolean } = {}) {
  render(<MantineProvider><LiveEntrySetupProgress account={overrides.account ?? account} assessment={overrides.assessment === undefined ? readiness : overrides.assessment} canaryStaged={overrides.staged ?? true} riskEffective={overrides.risk ?? true} entryEffective={overrides.entry ?? true} /></MantineProvider>);
  return screen.getByTestId('live-entry-next-action').textContent;
}

describe('LiveEntrySetupProgress', () => {
  afterEach(cleanup);
  it('directs an operator to grant ENTRY when it is missing', () => expect(show({ entry: false, assessment: { ...readiness, result: 'BLOCKED' } })).toContain('Grant ENTRY authorization'));
  it('directs an operator to run readiness when ENTRY is effective but readiness is stale', () => expect(show({ assessment: { ...readiness, validity: 'STALE' } })).toContain('Run a fresh Live Entry Arming assessment'));
  it('labels PASSED/CURRENT readiness as ready to arm', () => { show(); expect(screen.getByText('READY TO ARM')).toBeTruthy(); expect(screen.getByTestId('live-entry-next-action').textContent).toContain('ARM LIVE ENTRIES'); });
  it('directs an armed operator to execute the one-shot canary', () => expect(show({ account: { ...account, activeLiveEntryArmingId: 4, tradingEnabled: true, killSwitchEnabled: false } })).toContain('Execute the one-shot RSP canary'));
  it('directs a consumed operator to verify evidence and disarm', () => expect(show({ account: { ...account, latestLiveEntryArming: { id: 4, entryApprovalRevision: 1, tradingAccountSubscriptionId: 2, entryApprovalExpiresAt: '2026-08-18T20:00:00Z', armedAt: '2026-08-18T19:00:00Z', terminations: [{ type: 'CONSUMED', occurredAt: '2026-08-18T19:10:00Z' }] } } })).toContain('Verify execution evidence and DISARM'));
  it('keeps canonical safety requirements in a theme-aware, readable next-step panel', () => {
    show();
    expect(screen.getByText('ENTRY approval alone does not authorize a broker entry.')).toBeTruthy();
    expect(screen.getByText('No broker order has been sent.')).toBeTruthy();
    expect(screen.getByText('What happens next').textContent).toBe('What happens next');
    const style = screen.getByTestId('live-entry-next-panel').getAttribute('style') ?? '';
    expect(style).toContain('var(--mantine-color-default)');
    expect(style).toContain('var(--mantine-color-default-color)');
    expect(style).not.toContain('gray.0');
  });
});

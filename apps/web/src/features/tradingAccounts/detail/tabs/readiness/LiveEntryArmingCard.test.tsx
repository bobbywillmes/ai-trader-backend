// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccount, TradingAccountReadinessAssessment } from '../../../types';

const mutation = { mutate: vi.fn(), isPending: false, isError: false, error: null };
vi.mock('../../../hooks', () => ({
  useTradingAccountSubscriptions: () => ({ data: { accountSubscriptions: [{ id: 8, enabled: true, entriesEnabled: true, subscription: { key: 'rsp_dip_core' } }] } }),
  useLiveWriteApprovals: () => ({ data: { capabilities: [{ capability: 'ENTRY', effective: true, approval: { id: 4, revision: 2 } }, { capability: 'RISK_REDUCING', effective: true, approval: { id: 3, revision: 1 } }] } }),
  useStageLiveEntryCanary: () => mutation, useArmLiveEntries: () => mutation, useDisarmLiveEntries: () => mutation,
}));
import { LiveEntryArmingCard } from './LiveEntryArmingCard';

const account = { id: 1, status: 'ACTIVE', environment: 'LIVE', tradingEnabled: false, killSwitchEnabled: true, activeLiveEntryArmingId: null, updatedAt: '2026-08-18T19:00:00Z', credential: { verifiedAt: '2026-08-18T19:00:00Z' } } as TradingAccount;
const assessment = { id: 5, purpose: 'LIVE_ENTRY_ARMING', result: 'PASSED', validity: 'CURRENT', credentialVerifiedAt: '2026-08-18T19:00:00Z', evidence: { liveWriteApprovalRevisions: { riskReducing: 1, entry: 2 } } } as TradingAccountReadinessAssessment;

describe('LiveEntryArmingCard requirements', () => {
  afterEach(cleanup);
  it('keeps ARM predicates while replacing the duplicate checklist with concise guidance', async () => {
    render(<MantineProvider><LiveEntryArmingCard account={account} assessment={assessment} token="token" /></MantineProvider>);
    const arm = screen.getByRole('button', { name: 'ARM LIVE ENTRIES' });
    expect(arm.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByText('Requirements to ARM')).toBeNull();
    expect(screen.getByTestId('arm-disabled-guidance').textContent).toBe('Enter an operator reason to continue.');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Operator reason'), 'Arm canary');
    await user.type(screen.getByLabelText('Type ARM LIVE ENTRIES'), 'ARM LIVE ENTRIES');
    expect(arm.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('arm-disabled-guidance')).toBeNull();
  });
});

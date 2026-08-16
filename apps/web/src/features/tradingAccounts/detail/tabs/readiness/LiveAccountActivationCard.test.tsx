// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TradingAccount,
  TradingAccountReadinessAssessment,
} from '../../../types';

const mocks = vi.hoisted(() => ({
  owner: true,
  mutate: vi.fn(),
  effective: true,
}));
vi.mock('../../../../auth/useAuth', () => ({
  useIsSystemOwner: () => mocks.owner,
}));
vi.mock('../../../hooks', () => ({
  useActivateTradingAccount: () => ({
    mutate: mocks.mutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useLiveWriteApprovals: () => ({
    data: {
      capabilities: [
        { capability: 'RISK_REDUCING', effective: mocks.effective },
      ],
    },
  }),
}));
import { LiveAccountActivationCard } from './LiveAccountActivationCard';

const account = {
  id: 2,
  environment: 'LIVE',
  status: 'PAUSED',
  tradingEnabled: false,
  killSwitchEnabled: true,
  updatedAt: '2026-08-16T19:00:00.000Z',
} as TradingAccount;
const assessment = {
  id: 12,
  result: 'PASSED',
  validity: 'CURRENT',
} as TradingAccountReadinessAssessment;

describe('LiveAccountActivationCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = true;
    mocks.effective = true;
  });
  afterEach(cleanup);

  it('shows the disarmed before/after contract and submits typed evidence', async () => {
    render(
      <MantineProvider>
        <LiveAccountActivationCard
          account={account}
          assessment={assessment}
          token="token"
        />
      </MantineProvider>,
    );
    expect(screen.getByText('After: ACTIVE / ENTRY DISARMED')).toBeTruthy();
    expect(
      screen.getByText(/Activation performs no broker write/),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Activation reason'),
      'First activation',
    );
    await user.type(
      screen.getByLabelText('Type ACTIVATE LIVE ACCOUNT'),
      'ACTIVATE LIVE ACCOUNT',
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Activate account with entries disarmed',
      }),
    );
    expect(mocks.mutate).toHaveBeenCalledWith({
      readinessAssessmentId: 12,
      reason: 'First activation',
      typedConfirmation: 'ACTIVATE LIVE ACCOUNT',
      expectedUpdatedAt: account.updatedAt,
    });
  });

  it('is hidden from non-owners or without current passing readiness', () => {
    mocks.owner = false;
    const view = render(
      <MantineProvider>
        <LiveAccountActivationCard
          account={account}
          assessment={assessment}
          token="token"
        />
      </MantineProvider>,
    );
    expect(screen.queryByText('Activate Live account')).toBeNull();
    view.rerender(
      <MantineProvider>
        <LiveAccountActivationCard
          account={account}
          assessment={{ ...assessment, validity: 'STALE' }}
          token="token"
        />
      </MantineProvider>,
    );
    expect(screen.queryByText('Activate Live account')).toBeNull();
  });
});

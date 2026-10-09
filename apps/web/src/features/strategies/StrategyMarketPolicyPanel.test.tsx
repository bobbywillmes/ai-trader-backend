// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategyMarketPolicyResponse } from './types';

const mocks = vi.hoisted(() => ({ data: null as StrategyMarketPolicyResponse | null, validate: vi.fn(), activate: vi.fn(), saveRule: vi.fn(), prepare: vi.fn(), create: vi.fn() }));
const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false });
vi.mock('./hooks', () => ({
  useStrategyMarketPolicy: () => ({ data: mocks.data, isLoading: false, isError: false }),
  useMarketPolicyActions: () => ({ create: mutation(mocks.create), prepare: mutation(mocks.prepare), saveRule: mutation(mocks.saveRule), validate: mutation(mocks.validate), activate: mutation(mocks.activate) }),
}));
import { StrategyMarketPolicyPanel } from './StrategyMarketPolicyPanel';

const dimensions = [
  ['TREND', 'TREND_V1', ['DOWN', 'NEUTRAL', 'UP']], ['VOLATILITY', 'VOLATILITY_V1', ['LOW', 'NORMAL', 'HIGH', 'EXTREME']],
  ['BREADTH', 'BREADTH_V1', ['NEGATIVE', 'MIXED', 'POSITIVE']], ['PARTICIPATION', 'PARTICIPATION_V1', ['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE']],
  ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', ['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE']],
] as const;
const response = (status: 'PREPARED' | 'ACTIVE' = 'PREPARED'): StrategyMarketPolicyResponse => ({ authority: 'SHADOW_ONLY', supportedDimensions: dimensions.map(([dimension, algorithmVersion, allowedStates]) => ({ dimension, algorithmVersion, allowedStates })), policy: { id: 2, strategyId: 7, authority: 'SHADOW_ONLY', revisions: [{ id: 11, revision: 1, status, changeNote: null, createdAt: '2026-10-09T12:00:00Z', activatedAt: status === 'ACTIVE' ? '2026-10-09T12:01:00Z' : null, retiredAt: null, dimensionRules: dimensions.map(([dimension, algorithmVersion], i) => ({ id: i + 1, dimension, algorithmVersion, requirement: 'IGNORED', allowedStates: [] })) }] } });

describe('StrategyMarketPolicyPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.data = response(); }); afterEach(cleanup);
  const renderPanel = (owner = true) => render(<MantineProvider><StrategyMarketPolicyPanel strategyId={7} token="token" isOwner={owner} /></MantineProvider>);

  it('shows shadow authority, no active revision, and every explicit dimension', () => {
    renderPanel(); expect(screen.getByText('SHADOW ONLY')).toBeTruthy(); expect(screen.getByText('No active revision')).toBeTruthy();
    for (const [dimension] of dimensions) expect(screen.getByText(dimension.replaceAll('_', ' '))).toBeTruthy();
  });

  it('keeps activation disabled until backend validation succeeds and shows validation errors', async () => {
    mocks.validate.mockResolvedValue({ revisionId: 11, revision: 1, status: 'PREPARED', valid: false, errors: [{ dimension: 'TREND', code: 'ALLOWED_STATES_REQUIRED', message: 'Required TREND must allow at least one effective state.' }] });
    renderPanel(); expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/Required TREND must allow/)).toBeTruthy(); expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires activation confirmation after successful validation', async () => {
    mocks.validate.mockResolvedValue({ revisionId: 11, revision: 1, status: 'PREPARED', valid: true, errors: [] }); mocks.activate.mockResolvedValue({});
    renderPanel(); const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Validate' })); await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(screen.getByText(/currently active revision, if any, will be retired atomically/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm activation' })); expect(mocks.activate).toHaveBeenCalledWith({ id: 7, revisionId: 11 });
  });

  it('renders ACTIVE history read-only for non-owners', () => {
    mocks.data = response('ACTIVE'); renderPanel(false); expect(screen.getAllByText('Revision 1')).toHaveLength(2); expect(screen.queryByText('Save dimension')).toBeNull(); expect(screen.queryByText('Prepare new revision')).toBeNull();
  });
});

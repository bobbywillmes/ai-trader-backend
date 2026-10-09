// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategyMarketPolicyResponse } from './types';

const mocks = vi.hoisted(() => ({ data: null as StrategyMarketPolicyResponse | null, validate: vi.fn(), activate: vi.fn(), saveRevision: vi.fn(), prepare: vi.fn(), create: vi.fn() }));
const mutation = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false });
vi.mock('./hooks', () => ({
  useStrategyMarketPolicy: () => ({ data: mocks.data, isLoading: false, isError: false }),
  useMarketPolicyActions: () => ({ create: mutation(mocks.create), prepare: mutation(mocks.prepare), saveRevision: mutation(mocks.saveRevision), validate: mutation(mocks.validate), activate: mutation(mocks.activate) }),
}));
import { StrategyMarketPolicyPanel } from './UnifiedStrategyMarketPolicyPanel';

const dimensions = [
  ['TREND', 'TREND_V1', ['DOWN', 'NEUTRAL', 'UP']], ['VOLATILITY', 'VOLATILITY_V1', ['LOW', 'NORMAL', 'HIGH', 'EXTREME']],
  ['BREADTH', 'BREADTH_V1', ['NEGATIVE', 'MIXED', 'POSITIVE']], ['PARTICIPATION', 'PARTICIPATION_V1', ['QUIET', 'NORMAL', 'ACTIVE', 'INTENSE']],
  ['INTRADAY_STRESS', 'INTRADAY_STRESS_V1', ['NORMAL', 'ELEVATED', 'HIGH', 'SEVERE']],
] as const;
const response = (status: 'PREPARED' | 'ACTIVE' = 'PREPARED', fingerprint = 'a'.repeat(64)): StrategyMarketPolicyResponse => ({ authority: 'SHADOW_ONLY', supportedDimensions: dimensions.map(([dimension, algorithmVersion, allowedStates]) => ({ dimension, algorithmVersion, allowedStates })), policy: { id: 2, strategyId: 7, authority: 'SHADOW_ONLY', revisions: [{ id: 11, revision: 1, status, configurationFingerprint: fingerprint, changeNote: null, createdAt: '2026-10-09T12:00:00Z', activatedAt: status === 'ACTIVE' ? '2026-10-09T12:01:00Z' : null, retiredAt: null, dimensionRules: dimensions.map(([dimension, algorithmVersion], i) => ({ id: i + 1, dimension, algorithmVersion, requirement: dimension === 'TREND' ? 'REQUIRED' : 'IGNORED', allowedStates: dimension === 'TREND' ? [{ id: 20, state: 'UP' }] : [] })) }] } });

describe('StrategyMarketPolicyPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.data = response(); }); afterEach(cleanup);
  const renderPanel = (owner = true) => render(<MantineProvider><StrategyMarketPolicyPanel strategyId={7} token="token" isOwner={owner} /></MantineProvider>);

  it('shows shadow authority, no active revision, and every explicit dimension', () => {
    renderPanel(); expect(screen.getAllByText('SHADOW ONLY').length).toBeGreaterThan(0); expect(screen.getByText('No active revision')).toBeTruthy();
    for (const [dimension] of dimensions) expect(screen.getAllByText(dimension.replaceAll('_', ' ')).length).toBeGreaterThan(0);
  });

  it('keeps activation disabled until backend validation succeeds and shows validation errors', async () => {
    mocks.validate.mockResolvedValue({ revisionId: 11, revision: 1, status: 'PREPARED', configurationFingerprint: 'a'.repeat(64), valid: false, errors: [{ dimension: 'TREND', code: 'ALLOWED_STATES_REQUIRED', message: 'Required TREND must allow at least one effective state.' }] });
    renderPanel(); expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/Required TREND must allow/)).toBeTruthy(); expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires activation confirmation after successful validation', async () => {
    mocks.validate.mockResolvedValue({ revisionId: 11, revision: 1, status: 'PREPARED', configurationFingerprint: 'a'.repeat(64), valid: true, errors: [] }); mocks.activate.mockResolvedValue({});
    renderPanel(); const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Validate' })); await user.click(screen.getByRole('button', { name: 'Activate' }));
    expect(screen.getByText(/currently active revision, if any, will be retired atomically/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm activation' })); expect(mocks.activate).toHaveBeenCalledWith({ id: 7, revisionId: 11, expectedConfigurationFingerprint: 'a'.repeat(64) });
  });

  it('edits multiple dimensions and saves the complete revision once', async () => {
    mocks.saveRevision.mockImplementation(async ({ rules }) => ({ ...mocks.data!.policy!.revisions[0], configurationFingerprint: 'b'.repeat(64), dimensionRules: rules.map((rule: { dimension: string; algorithmVersion: string; requirement: string; allowedStates: string[] }, i: number) => ({ ...rule, id: i + 1, allowedStates: rule.allowedStates.map((state, j) => ({ id: j + 1, state })) })) }));
    renderPanel(); const user = userEvent.setup();
    await user.click(screen.getAllByLabelText('Required')[1]!); await user.click(screen.getByLabelText('EXTREME')); await user.click(screen.getByLabelText('DOWN'));
    expect(screen.getByText('2 dimensions changed')).toBeTruthy(); await user.click(screen.getByRole('button', { name: 'Save revision' }));
    expect(mocks.saveRevision).toHaveBeenCalledTimes(1); expect(mocks.saveRevision.mock.calls[0]![0].rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'TREND', allowedStates: expect.arrayContaining(['DOWN', 'UP']) }), expect.objectContaining({ dimension: 'VOLATILITY', requirement: 'REQUIRED', allowedStates: ['EXTREME'] }),
    ]));
    expect(screen.queryByText(/dimensions? changed/)).toBeNull(); expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables save and shows an inline error when one required dimension has no states', async () => {
    renderPanel(); await userEvent.setup().click(screen.getByLabelText('UP'));
    expect(screen.getByText('Select at least one allowed effective state.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('1 dimension changed')).toBeTruthy();
  });

  it('validates every required dimension independently before enabling save', async () => {
    renderPanel(); const user = userEvent.setup();
    await user.click(screen.getAllByLabelText('Required')[1]!);
    expect(screen.getByText('Select at least one allowed effective state.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText('EXTREME'));
    expect(screen.queryByText('Select at least one allowed effective state.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignores retained temporary states when comparing an ignored dimension', async () => {
    renderPanel(); const user = userEvent.setup();
    await user.click(screen.getAllByLabelText('Required')[1]!); await user.click(screen.getByLabelText('HIGH')); await user.click(screen.getAllByLabelText('Ignored')[1]!);
    expect(screen.queryByText(/dimension changed/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getAllByLabelText('Required')[1]!);
    expect((screen.getByLabelText('HIGH') as HTMLInputElement).checked).toBe(true);
  });

  it('allows an all-ignored prepared draft to be saved while leaving activation validation to the backend', async () => {
    renderPanel(); await userEvent.setup().click(screen.getAllByLabelText('Ignored')[0]!);
    expect(screen.queryByText('Draft validation errors')).toBeNull();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows allowed-state additions and removals and clears changes after reversion', async () => {
    mocks.data!.policy!.revisions[0]!.dimensionRules[0]!.allowedStates = [{ id: 21, state: 'UP' }, { id: 20, state: 'DOWN' }];
    renderPanel(); const user = userEvent.setup();
    expect((screen.getByRole('button', { name: 'Save revision' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByLabelText('DOWN'));
    expect(screen.getByText('Before:').parentElement?.textContent).toContain('REQUIRED · Allowed: DOWN, UP');
    expect(screen.getByText('After:').parentElement?.textContent).toContain('REQUIRED · Allowed: UP');
    await user.click(screen.getByLabelText('DOWN'));
    expect(screen.queryByText('Changed')).toBeNull();
    expect(screen.queryByText(/dimension changed/)).toBeNull();
  });

  it('tracks requirement changes and removes the indicator when reverted', async () => {
    renderPanel(); const user = userEvent.setup();
    await user.click(screen.getAllByLabelText('Ignored')[0]!);
    expect(screen.getByText('Changed')).toBeTruthy(); expect(screen.getByText('After:').parentElement?.textContent).toContain('IGNORED');
    await user.click(screen.getAllByLabelText('Required')[0]!);
    expect(screen.queryByText('Changed')).toBeNull(); expect(screen.queryByText(/dimension changed/)).toBeNull();
  });

  it('detects and discards dirty state without changing persisted configuration', async () => {
    renderPanel(); const user = userEvent.setup(); await user.click(screen.getByLabelText('DOWN')); expect(screen.getByText('1 dimension changed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard changes' })); expect(screen.queryByText(/dimension changed/)).toBeNull(); expect((screen.getByLabelText('DOWN') as HTMLInputElement).checked).toBe(false);
  });

  it('retains unsaved changes after an atomic save failure and blocks validation and activation', async () => {
    mocks.saveRevision.mockRejectedValue(new Error('Revision changed.')); renderPanel(); const user = userEvent.setup(); await user.click(screen.getByLabelText('DOWN'));
    expect((screen.getByRole('button', { name: 'Validate' }) as HTMLButtonElement).disabled).toBe(true); expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save revision' })); expect(screen.getByText('1 dimension changed')).toBeTruthy(); expect((screen.getByLabelText('DOWN') as HTMLInputElement).checked).toBe(true);
  });

  it('clears a stale successful validation when the persisted fingerprint changes', async () => {
    mocks.validate.mockResolvedValue({ revisionId: 11, revision: 1, status: 'PREPARED', configurationFingerprint: 'a'.repeat(64), valid: true, errors: [] });
    const view = renderPanel(); await userEvent.setup().click(screen.getByRole('button', { name: 'Validate' })); expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(false);
    mocks.data = response('PREPARED', 'b'.repeat(64)); view.rerender(<MantineProvider><StrategyMarketPolicyPanel strategyId={7} token="token" isOwner /></MantineProvider>);
    expect((screen.getByRole('button', { name: 'Activate' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders ACTIVE history read-only for non-owners', () => {
    mocks.data = response('ACTIVE'); renderPanel(false); expect(screen.getAllByText('Revision 1')).toHaveLength(2); expect(screen.getByText('Allowed: UP')).toBeTruthy(); expect(screen.getAllByText('SHADOW ONLY').length).toBeGreaterThan(1); expect(screen.queryByText('Save revision')).toBeNull(); expect(screen.queryByText('Prepare new revision')).toBeNull();
  });

  it('keeps every dimension and lifecycle action accessible at narrow viewport width', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 }); window.dispatchEvent(new Event('resize')); renderPanel();
    expect(screen.getAllByText(/TREND|VOLATILITY|BREADTH|PARTICIPATION|INTRADAY STRESS/).length).toBeGreaterThanOrEqual(5);
    for (const action of ['Discard changes', 'Save revision', 'Validate', 'Activate']) expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });
});

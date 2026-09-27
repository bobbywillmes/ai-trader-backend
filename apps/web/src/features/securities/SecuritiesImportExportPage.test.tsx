// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecuritiesImportExportPage } from './SecuritiesImportExportPage';

const mocks = vi.hoisted(() => ({ requestImport: vi.fn(), requestFreeze: vi.fn(), downloadSecurityCsv: vi.fn() }));
vi.mock('./universeApi', () => ({ ...mocks }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderPage() {
  return render(<MantineProvider><QueryClientProvider client={new QueryClient()}><MemoryRouter><SecuritiesImportExportPage /></MemoryRouter></QueryClientProvider></MantineProvider>);
}
describe('Securities import/export review', () => {
  it('requires preview before apply and blocks conflicts', async () => {
    mocks.requestImport.mockResolvedValue({ applied: false, mode: 'partial', effectiveDate: '2026-10-01', inputSecurityCount: 1, suppliedColumns: ['symbol'], omittedColumns: ['name'], newSecurities: [], metadataChanges: [], membershipAdditions: [], membershipRemovals: [], unchangedMembershipValues: [], conflicts: ['Review conflict'], missingUniverses: [], currentBroadMemberCount: 0, resultingBroadMemberCount: 0, universeCounts: [] });
    renderPage();
    const apply = screen.getByRole('button', { name: 'Apply reviewed import' }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const user = userEvent.setup();
    const file = new File(['symbol\nAAPL\n'], 'review.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'symbol\nAAPL\n' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await user.type(screen.getByLabelText('Effective date'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(mocks.requestImport).toHaveBeenCalledOnce());
    expect(mocks.requestImport.mock.calls[0][1]).toBe(false);
    expect(apply.disabled).toBe(true);
    expect(screen.getByRole('heading', { name: 'Import Preview' })).toBeTruthy();
    expect(screen.getByText('CONFLICTS')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Import Result' })).toBeNull();
    expect(screen.getByText('Review conflict')).toBeTruthy();
  });
  it('does not offer a Breadth freeze when source membership changes leave the broad set unchanged', async () => {
    const plan = { applied: false, mode: 'partial', effectiveDate: '2026-10-01', inputSecurityCount: 1, suppliedColumns: ['symbol', 'SP600'], omittedColumns: ['name', 'sector'], newSecurities: [], metadataChanges: [], membershipAdditions: [{ symbol: 'AAPL', code: 'SP600' }], membershipRemovals: [], unchangedMembershipValues: [], conflicts: [], missingUniverses: ['SP600'], currentBroadMemberCount: 1, resultingBroadMemberCount: 1, universeCounts: [{ code: 'SP500', before: 1, after: 1 }, { code: 'NASDAQ100', before: 0, after: 0 }, { code: 'DJIA', before: 0, after: 0 }, { code: 'RUSSELL2000', before: 0, after: 0 }, { code: 'SP400', before: 0, after: 0 }, { code: 'SP600', before: 0, after: 1 }], breadthMembershipChanged: false };
    mocks.requestImport.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, applied: true });
    renderPage();
    const user = userEvent.setup();
    const file = new File(['symbol,SP600\nAAPL,1\n'], 'review.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'symbol,SP600\nAAPL,1\n' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await user.type(screen.getByLabelText('Effective date'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply reviewed import' }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('heading', { name: 'Import Preview' })).toBeTruthy();
    expect(screen.getByText('READY TO APPLY')).toBeTruthy();
    expect(within(screen.getByTestId('import-plan-summary')).getByText('review.csv')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Import Scope' })).toBeTruthy();
    expect(screen.getByText('Supplied fields')).toBeTruthy();
    expect(screen.getByText('Omitted fields · unchanged')).toBeTruthy();
    expect(screen.getByText('Source universes to initialize')).toBeTruthy();
    expect(within(screen.getByTestId('summary-securities')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('summary-broad')).getByText('1 → 1')).toBeTruthy();
    expect(within(screen.getByTestId('summary-additions')).getByText('1')).toBeTruthy();
    expect(within(screen.getByTestId('summary-removals')).getByText('0')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Universe Membership Impact' })).toBeTruthy();
    expect(within(screen.getByTestId('universe-impact-SP600')).getByText('Changed')).toBeTruthy();
    expect(within(screen.getByTestId('universe-impact-SP500')).queryByText('Changed')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apply reviewed import' }));
    await waitFor(() => expect(screen.getByText('Import applied.')).toBeTruthy());
    expect(screen.getByRole('heading', { name: 'Import Result' })).toBeTruthy();
    expect(screen.getByText('Applied import')).toBeTruthy();
    expect(screen.getByText('APPLIED')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Import Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Preview Breadth Revision' })).toBeNull();
    expect(mocks.requestFreeze).not.toHaveBeenCalled();
  });
});

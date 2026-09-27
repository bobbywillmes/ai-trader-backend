// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText('Review conflict')).toBeTruthy();
  });
  it('does not offer a Breadth freeze when source membership changes leave the broad set unchanged', async () => {
    const plan = { applied: false, mode: 'partial', effectiveDate: '2026-10-01', inputSecurityCount: 1, suppliedColumns: ['symbol', 'SP600'], omittedColumns: [], newSecurities: [], metadataChanges: [], membershipAdditions: [{ symbol: 'AAPL', code: 'SP600' }], membershipRemovals: [], unchangedMembershipValues: [], conflicts: [], missingUniverses: [], currentBroadMemberCount: 1, resultingBroadMemberCount: 1, universeCounts: [], breadthMembershipChanged: false };
    mocks.requestImport.mockResolvedValueOnce(plan).mockResolvedValueOnce({ ...plan, applied: true });
    renderPage();
    const user = userEvent.setup();
    const file = new File(['symbol,SP600\nAAPL,1\n'], 'review.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => 'symbol,SP600\nAAPL,1\n' });
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
    await user.type(screen.getByLabelText('Effective date'), '2026-10-01');
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply reviewed import' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Apply reviewed import' }));
    await waitFor(() => expect(screen.getByText('Import applied.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Preview Breadth Revision' })).toBeNull();
    expect(mocks.requestFreeze).not.toHaveBeenCalled();
  });
});

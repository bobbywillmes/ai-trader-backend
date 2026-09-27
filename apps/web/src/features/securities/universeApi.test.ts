// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminNavGroups } from '../../app/navigation';
import { downloadSecurityCsv, requestImport } from './universeApi';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe('Securities import/export client', () => {
  it('uses separate preview and apply endpoints with the reviewed input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '{}', status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const input = { csv: 'symbol\nAAPL\n', effectiveDate: '2026-10-01', mode: 'partial' as const };
    await requestImport(input, false);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/securities/universe-import/preview');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
    await requestImport(input, true);
    expect(fetchMock.mock.calls[1][0]).toContain('/api/securities/universe-import/apply');
  });
  it('downloads backend CSV as an attachment and does not add a navigation item', async () => {
    localStorage.setItem('ai_trader_admin_token', 'test-token');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => 'attachment; filename="universe-snapshot-2026-10-01.csv"' }, blob: async () => new Blob(['symbol\nAAPL\n']) });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await downloadSecurityCsv('universe-snapshot');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    expect(click).toHaveBeenCalledOnce();
    expect(adminNavGroups.flatMap(group => group.items).some(item => item.to === '/securities/import-export')).toBe(false);
  });
});

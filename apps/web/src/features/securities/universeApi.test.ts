// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminNavGroups } from '../../app/navigation';
import { downloadSecurityCsv, requestBreadthStatus, requestFreeze, requestImport } from './universeApi';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

describe('Securities import/export client', () => {
  it('uses separate preview and apply endpoints with the reviewed input', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '{}', status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const input = { csv: 'symbol\nAAPL\n', timing: { kind: 'immediate' as const } as const };
    await requestImport(input, false);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/securities/universe-import/preview');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(input);
    await requestImport(input, true);
    expect(fetchMock.mock.calls[1][0]).toContain('/api/securities/universe-import/apply');
  });
  it('reads persistent Breadth status and guards current-date preview/freeze requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '{}', status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    await requestBreadthStatus();
    expect(fetchMock.mock.calls[0][0]).toContain('/api/securities/breadth-revision/status');
    await requestFreeze('2026-10-01', false, '2026-10-01');
    const hash = 'a'.repeat(64);
    await requestFreeze('2026-10-01', true, '2026-10-01', hash);
    expect(fetchMock.mock.calls[1][0]).toContain('/api/securities/breadth-revision/preview');
    expect(fetchMock.mock.calls[2][0]).toContain('/api/securities/breadth-revision/freeze');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ effectiveDate: '2026-10-01', expectedAsOfDate: '2026-10-01', expectedConstituentHash: hash });
  });
  it('uses each backend attachment filename for the actual download and does not add a navigation item', async () => {
    localStorage.setItem('ai_trader_admin_token', 'test-token');
    const filenames = ['universe-snapshot-2026-09-27T16-52-41-384Z.csv', 'security-catalog-2026-09-27T16-52-41-385Z.csv'];
    const fetchMock = vi.fn().mockImplementation(async () => ({ ok: true, headers: { get: () => `attachment; filename="${filenames[fetchMock.mock.calls.length - 1]}"` }, blob: async () => new Blob(['symbol\nAAPL\n']) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    await downloadSecurityCsv('universe-snapshot');
    await downloadSecurityCsv('security-catalog');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    expect(downloads).toEqual(filenames);
    expect(adminNavGroups.flatMap(group => group.items).some(item => item.to === '/securities/import-export')).toBe(false);
  });
});

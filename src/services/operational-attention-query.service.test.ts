import { OperationalAttentionStatus, PlatformRole, SystemEventSeverity } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), resolveScope: vi.fn() }));
vi.mock('../db/prisma.js', () => ({ prisma: { operationalAttention: { findMany: mocks.findMany, findUnique: mocks.findUnique } } }));
vi.mock('./report-scope.service.js', () => ({ resolveReportAccountIds: mocks.resolveScope }));

import { compareOperationalAttention, getOperationalAttentionDetail, listOperationalAttention, summarizeOperationalAttention } from './operational-attention-query.service.js';

const date = (value: string) => new Date(value);
function row(id: number, status: OperationalAttentionStatus, severity: SystemEventSeverity, overrides: Record<string, unknown> = {}) {
  return {
    id, tradingAccountId: 2, code: 'DEMO', source: 'DEMO', status, severity,
    title: `Episode ${id}`, message: 'Review condition.', detailsJson: { token: 'secret', safe: 'visible' },
    occurrenceCount: 1, revision: 1, resolutionPolicy: 'MANUAL_ALLOWED', trackedPositionId: null,
    orderIntentId: null, brokerOrderId: null, firstObservedAt: date('2026-08-28T10:00:00Z'),
    lastObservedAt: date('2026-08-28T10:00:00Z'), resolvedAt: status === 'RESOLVED' ? date('2026-08-28T12:00:00Z') : null,
    tradingAccount: { id: 2, displayName: 'Paper', environment: 'PAPER' }, ...overrides,
  };
}

describe('OperationalAttention query semantics', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.resolveScope.mockResolvedValue([2]); mocks.findMany.mockResolvedValue([]); });

  it('orders unresolved by severity, status, age and ID before newest resolved history', () => {
    const rows = [
      row(8, OperationalAttentionStatus.RESOLVED, SystemEventSeverity.CRITICAL, { resolvedAt: date('2026-08-28T12:00:00Z') }),
      row(3, OperationalAttentionStatus.ACKNOWLEDGED, SystemEventSeverity.CRITICAL),
      row(2, OperationalAttentionStatus.OPEN, SystemEventSeverity.WARNING),
      row(1, OperationalAttentionStatus.OPEN, SystemEventSeverity.CRITICAL),
      row(9, OperationalAttentionStatus.RESOLVED, SystemEventSeverity.WARNING, { resolvedAt: date('2026-08-28T13:00:00Z') }),
      row(4, OperationalAttentionStatus.OPEN, SystemEventSeverity.ERROR),
    ];
    expect(rows.sort(compareOperationalAttention).map(({ id }) => id)).toEqual([1, 3, 4, 2, 9, 8]);
  });

  it('uses deterministic ID tie-breakers for unresolved and resolved pagination', () => {
    expect([row(2, OperationalAttentionStatus.OPEN, SystemEventSeverity.ERROR), row(1, OperationalAttentionStatus.OPEN, SystemEventSeverity.ERROR)].sort(compareOperationalAttention).map(({ id }) => id)).toEqual([1, 2]);
    expect([row(1, OperationalAttentionStatus.RESOLVED, SystemEventSeverity.ERROR), row(2, OperationalAttentionStatus.RESOLVED, SystemEventSeverity.ERROR)].sort(compareOperationalAttention).map(({ id }) => id)).toEqual([2, 1]);
  });

  it('passes explicit all statuses to one server query and paginates after domain ordering', async () => {
    mocks.findMany.mockResolvedValue([
      row(4, OperationalAttentionStatus.RESOLVED, SystemEventSeverity.WARNING),
      row(2, OperationalAttentionStatus.OPEN, SystemEventSeverity.ERROR),
      row(3, OperationalAttentionStatus.ACKNOWLEDGED, SystemEventSeverity.WARNING),
      row(1, OperationalAttentionStatus.OPEN, SystemEventSeverity.CRITICAL),
    ]);
    const result = await listOperationalAttention({ id: 7, platformRole: PlatformRole.SYSTEM_OWNER }, { accountId: null, statuses: Object.values(OperationalAttentionStatus), page: 1, pageSize: 3 });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: Object.values(OperationalAttentionStatus) } }) }));
    expect(result.items.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 3, total: 4, totalPages: 2 });
  });

  it.each([
    [undefined, [OperationalAttentionStatus.OPEN, OperationalAttentionStatus.ACKNOWLEDGED]],
    [[OperationalAttentionStatus.OPEN], [OperationalAttentionStatus.OPEN]],
    [[OperationalAttentionStatus.ACKNOWLEDGED], [OperationalAttentionStatus.ACKNOWLEDGED]],
    [[OperationalAttentionStatus.RESOLVED], [OperationalAttentionStatus.RESOLVED]],
  ] as const)('applies the intended status filter %#', async (statuses, expected) => {
    await listOperationalAttention({ id: 7, platformRole: PlatformRole.OPERATOR }, { accountId: 2, ...(statuses ? { statuses: [...statuses] } : {}), page: 1, pageSize: 25 });
    expect(mocks.resolveScope).toHaveBeenCalledWith({ id: 7, platformRole: PlatformRole.OPERATOR }, 2);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tradingAccountId: { in: [2] }, status: { in: expected } }) }));
  });

  it('keeps acknowledged in summaries, excludes resolved, and sanitizes preview details', async () => {
    mocks.resolveScope.mockResolvedValue([2, 3]);
    mocks.findMany.mockResolvedValue([row(1, OperationalAttentionStatus.ACKNOWLEDGED, SystemEventSeverity.ERROR)]);
    const summary = await summarizeOperationalAttention({ id: 7, platformRole: PlatformRole.SYSTEM_OWNER }, null);
    expect(summary).toMatchObject({ totalUnresolved: 1, openCount: 0, acknowledgedCount: 1, highestSeverity: SystemEventSeverity.ERROR });
    expect(summary.preview[0]?.detailsJson).toEqual({ token: '[REDACTED]', safe: 'visible' });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: { in: [OperationalAttentionStatus.OPEN, OperationalAttentionStatus.ACKNOWLEDGED] } }) }));
  });

  it('enforces detail account scope without exposing raw secret details', async () => {
    mocks.findUnique.mockResolvedValue({ ...row(5, OperationalAttentionStatus.OPEN, SystemEventSeverity.WARNING), evidenceEvents: [] });
    const detail = await getOperationalAttentionDetail({ id: 9, platformRole: PlatformRole.OPERATOR }, 5);
    expect(mocks.resolveScope).toHaveBeenCalledWith({ id: 9, platformRole: PlatformRole.OPERATOR }, 2);
    expect(detail.detailsJson).toEqual({ token: '[REDACTED]', safe: 'visible' });
  });
});

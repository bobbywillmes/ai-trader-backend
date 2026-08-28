import { OperationalAttentionStatus, PlatformRole, SystemEventSeverity } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { resolveReportAccountIds } from './report-scope.service.js';
import { sanitizeOperationalAttentionDetails } from './operational-attention.service.js';

type UserScope = { id: number; platformRole: PlatformRole };
const unresolved = [OperationalAttentionStatus.OPEN, OperationalAttentionStatus.ACKNOWLEDGED];
const severityOrder: Record<SystemEventSeverity, number> = { CRITICAL: 0, ERROR: 1, WARNING: 2, INFO: 3 };

export function compareOperationalAttention(a: {
  id: number; status: OperationalAttentionStatus; severity: SystemEventSeverity;
  firstObservedAt: Date; resolvedAt: Date | null;
}, b: {
  id: number; status: OperationalAttentionStatus; severity: SystemEventSeverity;
  firstObservedAt: Date; resolvedAt: Date | null;
}) {
  const aResolved = a.status === OperationalAttentionStatus.RESOLVED;
  const bResolved = b.status === OperationalAttentionStatus.RESOLVED;
  if (aResolved !== bResolved) return aResolved ? 1 : -1;
  if (aResolved && bResolved) {
    return (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0) || b.id - a.id;
  }
  return severityOrder[a.severity] - severityOrder[b.severity]
    || (a.status === b.status ? 0 : a.status === OperationalAttentionStatus.OPEN ? -1 : 1)
    || a.firstObservedAt.getTime() - b.firstObservedAt.getTime()
    || a.id - b.id;
}

function links(row: { tradingAccountId: number; trackedPositionId: number | null; orderIntentId: number | null; brokerOrderId: number | null }) {
  return {
    account: `/trading-accounts/${row.tradingAccountId}`,
    reconciliation: `/trading-accounts/${row.tradingAccountId}/reconciliation`,
    position: row.trackedPositionId ? `/positions/open?account=${row.tradingAccountId}&position=${row.trackedPositionId}` : null,
    order: row.orderIntentId || row.brokerOrderId ? `/orders?account=${row.tradingAccountId}` : null,
    systemEvents: `/system-events?account=${row.tradingAccountId}`,
  };
}

function present(row: any, user: UserScope) {
  return {
    ...row,
    detailsJson: sanitizeOperationalAttentionDetails(row.detailsJson),
    links: links(row),
    allowedActions: {
      acknowledge: row.status === 'OPEN' && user.platformRole !== PlatformRole.ACCOUNT_USER,
      manualResolve: row.status !== 'RESOLVED' && row.resolutionPolicy === 'MANUAL_ALLOWED' && user.platformRole === PlatformRole.SYSTEM_OWNER,
    },
  };
}

export async function listOperationalAttention(user: UserScope, args: {
  accountId: number | null; statuses?: OperationalAttentionStatus[]; severities?: SystemEventSeverity[];
  source?: string; code?: string; page: number; pageSize: number;
}) {
  const accountIds = await resolveReportAccountIds(user, args.accountId);
  const where = {
    tradingAccountId: { in: accountIds },
    status: { in: args.statuses?.length ? args.statuses : unresolved },
    ...(args.severities?.length ? { severity: { in: args.severities } } : {}),
    ...(args.source ? { source: args.source } : {}),
    ...(args.code ? { code: args.code } : {}),
  };
  const rows = await prisma.operationalAttention.findMany({
      where, include: { tradingAccount: { select: { id: true, displayName: true, environment: true } } },
    });
  rows.sort(compareOperationalAttention);
  const total = rows.length;
  const pageRows = rows.slice((args.page - 1) * args.pageSize, args.page * args.pageSize);
  return { items: pageRows.map((row) => present(row, user)), pagination: { page: args.page, pageSize: args.pageSize, total, totalPages: Math.ceil(total / args.pageSize) } };
}

export async function summarizeOperationalAttention(user: UserScope, accountId: number | null) {
  const accessibleIds = await resolveReportAccountIds(user, null);
  if (accountId !== null) await resolveReportAccountIds(user, accountId);
  const scope = accountId === null ? accessibleIds : [accountId];
  const rows = await prisma.operationalAttention.findMany({
    where: { status: { in: unresolved }, OR: [{ tradingAccountId: { in: scope } }, { tradingAccountId: { in: accessibleIds }, severity: SystemEventSeverity.CRITICAL, tradingAccount: { environment: 'LIVE' } }] },
    include: { tradingAccount: { select: { id: true, displayName: true, environment: true } } },
  });
  rows.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || a.firstObservedAt.getTime() - b.firstObservedAt.getTime());
  const bySeverity = Object.fromEntries(Object.values(SystemEventSeverity).map((severity) => [severity, rows.filter((row) => row.severity === severity).length]));
  return {
    totalUnresolved: rows.length,
    openCount: rows.filter((row) => row.status === 'OPEN').length,
    acknowledgedCount: rows.filter((row) => row.status === 'ACKNOWLEDGED').length,
    bySeverity,
    highestSeverity: rows[0]?.severity ?? null,
    criticalLiveAccounts: [...new Set(rows.filter((row) => row.severity === 'CRITICAL' && row.tradingAccount.environment === 'LIVE').map((row) => row.tradingAccountId))],
    preview: rows.slice(0, 5).map((row) => present(row, user)),
    evidenceAt: new Date().toISOString(),
  };
}

export async function getOperationalAttentionDetail(user: UserScope, id: number) {
  const row = await prisma.operationalAttention.findUnique({
    where: { id },
    include: {
      tradingAccount: { select: { id: true, displayName: true, environment: true } },
      trackedPosition: { select: { id: true, symbol: true, status: true } },
      orderIntent: { select: { id: true, symbol: true, status: true, clientOrderId: true } },
      brokerOrder: { select: { id: true, symbol: true, status: true, clientOrderId: true } },
      acknowledgedByUser: { select: { id: true, name: true, email: true } },
      resolvedByUser: { select: { id: true, name: true, email: true } },
      evidenceEvents: { include: { systemEvent: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!row) throw new HttpError(404, 'Operational attention was not found.');
  const ids = await resolveReportAccountIds(user, row.tradingAccountId);
  if (!ids.includes(row.tradingAccountId)) throw new HttpError(404, 'Operational attention was not found.');
  return present(row, user);
}

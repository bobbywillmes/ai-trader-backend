import { ExternalSignalCorrelationWorkStatus, ExternalSignalTradeCycleStatus, type Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

type Db = typeof prisma;
export type ExternalSignalOperationsFilters = {
  page: number; pageSize: number; status?: ExternalSignalTradeCycleStatus | undefined;
  workStatus?: ExternalSignalCorrelationWorkStatus | undefined; event?: 'ENTRY_LONG' | 'EXIT_LONG' | undefined;
  unresolvedExit?: boolean | undefined;
};

const cycleInclude = {
  binding: { select: { id: true, externalStrategyKey: true, signalSource: { select: { id: true, name: true } }, strategy: { select: { id: true, key: true, name: true } } } },
  revision: { select: { id: true, revision: true, authorityMode: true, status: true } },
  security: { select: { id: true, symbol: true } },
  signals: { orderBy: { id: 'asc' as const }, include: {
    correlationWork: true,
    routingRun: { include: { routes: { orderBy: { id: 'asc' as const }, include: { marketEligibilityAttempts: { orderBy: { attempt: 'asc' as const } } } } } },
  } },
  accountCycles: { orderBy: { id: 'asc' as const }, include: { tradingAccount: { select: { id: true, displayName: true, environment: true } }, correlationDecisions: { orderBy: { id: 'asc' as const } } } },
  correlationDecisions: { orderBy: { id: 'asc' as const }, include: { rolloutGeneration: true } },
} satisfies Prisma.ExternalSignalTradeCycleInclude;

function exitResolution(cycle: any) {
  const exits = cycle.signals.filter((signal: any) => signal.schemaVersion === 2 && signal.event === 'EXIT_LONG');
  const terminal = ['TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'].includes(cycle.status);
  return exits.map((signal: any) => {
    const decisions = cycle.correlationDecisions.filter((row: any) => row.signalId === signal.id && row.decisionType === 'EXIT_PENDING');
    const work = signal.correlationWork;
    const applied = terminal || (decisions.length > 0 && decisions.every((row: any) => row.accountCycleId && cycle.accountCycles.some((account: any) => account.id === row.accountCycleId && ['EXIT_PENDING', 'TERMINAL_NO_EXPOSURE', 'TERMINAL_CLOSED'].includes(account.status))));
    const unresolved = !applied || !work || work.status !== 'COMPLETED';
    return { signalId: signal.id, workId: work?.id ?? null, workStatus: work?.status ?? 'MISSING',
      acceptedAt: signal.createdAt, decisionCount: decisions.length, applied, unresolved,
      reasonCode: unresolved ? !work ? 'CORRELATION_WORK_MISSING' : work.status === 'FAILED' ? 'CORRELATION_FAILED' : work.status !== 'COMPLETED' ? `CORRELATION_${work.status}` : 'EXIT_NOT_APPLIED' : 'EXIT_OBLIGATION_APPLIED' };
  });
}

function present(cycle: any, now = new Date()) {
  const exitObligations = exitResolution(cycle);
  return { ...cycle, shadowOnly: true, actualExecutionAuthority: 'NONE', hypotheticalEntryAuthority: cycle.accountCycles.some((row: any) => row.entryReservationKey) ? 'SHADOW_RESERVATION_ONLY' : 'NONE',
    exitObligations, unresolvedExitCount: exitObligations.filter((row: { unresolved: boolean }) => row.unresolved).length,
    work: cycle.signals.map((signal: any) => signal.correlationWork ? { ...signal.correlationWork, event: signal.event,
      ageMs: Math.max(0, now.getTime() - signal.correlationWork.createdAt.getTime()),
      stalledLease: signal.correlationWork.status === 'CLAIMED' && Boolean(signal.correlationWork.leaseExpiresAt && signal.correlationWork.leaseExpiresAt <= now) } : null).filter(Boolean),
  };
}

export async function listExternalSignalOperations(filters: ExternalSignalOperationsFilters, db: Db = prisma) {
  const signalPredicates: Prisma.SignalWhereInput[] = [];
  if (filters.event) signalPredicates.push({ event: filters.event });
  if (filters.workStatus) signalPredicates.push({ correlationWork: { status: filters.workStatus } });
  const where: Prisma.ExternalSignalTradeCycleWhereInput = {
    ...(filters.status ? { status: filters.status } : {}),
    ...(signalPredicates.length ? { AND: signalPredicates.map(predicate => ({ signals: { some: predicate } })) } : {}),
  };
  const rows = await db.externalSignalTradeCycle.findMany({ where, include: cycleInclude, orderBy: { id: 'desc' } });
  const presented = rows.map(row => present(row)).filter(row => filters.unresolvedExit === undefined || (row.unresolvedExitCount > 0) === filters.unresolvedExit);
  const start = (filters.page - 1) * filters.pageSize;
  const workRows = presented.flatMap(row => row.work);
  const summary = { shadowOnly: true, totalCycles: presented.length, unresolvedExitObligations: presented.reduce((sum, row) => sum + row.unresolvedExitCount, 0),
    work: Object.fromEntries(Object.values(ExternalSignalCorrelationWorkStatus).map(status => [status, workRows.filter(row => row.status === status).length])),
    stalledLeases: workRows.filter(row => row.stalledLease).length, evaluatedAt: new Date().toISOString() };
  return { cycles: presented.slice(start, start + filters.pageSize), summary,
    pagination: { page: filters.page, pageSize: filters.pageSize, total: presented.length, totalPages: Math.max(1, Math.ceil(presented.length / filters.pageSize)) } };
}

export async function getExternalSignalOperation(id: number, db: Db = prisma) {
  const row = await db.externalSignalTradeCycle.findUnique({ where: { id }, include: cycleInclude });
  if (!row) throw new HttpError(404, 'External signal trade cycle was not found.');
  return present(row);
}

import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';

// Deliberately limited capability: this service cannot access trading write models.
type RoutingDb = Pick<Prisma.TransactionClient, '$queryRaw' | 'signal' | 'signalRoutingRun' | 'tradingAccountSubscription'>;
export const routingRunInclude = { routes: { orderBy: { tradingAccountId: 'asc' as const } } };

export async function routeSignalInTransaction(signalId: number, db: RoutingDb) {
  // Independent callers and ingestion share the same per-Signal serialization.
  await db.$queryRaw`SELECT id FROM "Signal" WHERE id = ${signalId} FOR UPDATE`;
  const existing = await db.signalRoutingRun.findUnique({ where: { signalId }, include: routingRunInclude });
  if (existing) return existing;
  const startedAt = new Date();
  const signal = await db.signal.findUnique({ where: { id: signalId }, include: { strategySignalRevision: true } });
  if (!signal) throw new HttpError(404, 'Signal not found.');
  // Legacy labels have no authority-bearing revision. Never infer one from current configuration.
  const authorityMode = signal.strategySignalRevision?.authorityMode ?? 'EVIDENCE_ONLY';
  const stopped = authorityMode === 'EVIDENCE_ONLY';
  const targets = stopped ? [] : await db.tradingAccountSubscription.findMany({
    where: { enabled: true, subscription: { enabled: true, strategyId: signal.strategyId, securityId: signal.securityId } },
    select: {
      id: true, tradingAccountId: true, subscriptionId: true,
      tradingAccount: { select: { displayName: true } },
      subscription: { select: { key: true, name: true,
        strategy: { select: { id: true, key: true, name: true } },
        security: { select: { id: true, symbol: true } },
      } },
    }, orderBy: { tradingAccountId: 'asc' },
  });
  // Defense in depth for unexpected database/configuration corruption: never guess.
  if (new Set(targets.map(target => target.tradingAccountId)).size !== targets.length) {
    throw new HttpError(409, 'Ambiguous active signal routing configuration.');
  }
  return db.signalRoutingRun.create({ data: {
    signalId, authorityMode, status: stopped ? 'STOPPED' : 'COMPLETED',
    startedAt, completedAt: new Date(), routeCount: targets.length,
    stopReason: stopped ? (signal.strategySignalRevision ? 'EVIDENCE_ONLY_AUTHORITY' : 'LEGACY_REVISION_NO_AUTHORITY') : null,
    routes: { create: targets.map(target => ({
      tradingAccountId: target.tradingAccountId, tradingAccountSubscriptionId: target.id, subscriptionId: target.subscriptionId,
      targetSnapshot: { tradingAccountName: target.tradingAccount.displayName, subscriptionKey: target.subscription.key,
        subscriptionName: target.subscription.name, strategy: target.subscription.strategy, security: target.subscription.security },
    })) },
  }, include: routingRunInclude });
}

// Explicit service boundary for retries/tests; no worker or execution continuation.
export function routeSignal(signalId: number, client = prisma) {
  return client.$transaction(db => routeSignalInTransaction(signalId, db));
}

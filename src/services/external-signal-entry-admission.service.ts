import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { submitOrder } from './place-order.service.js';
import { reconcileReleasedTradingViewAdmissionCyclesForAccount } from './external-signal-entry-recovery.service.js';

type Db = PrismaClient;

export const TRADINGVIEW_ENTRY_MAX_AGE_MS = (() => {
  const seconds = Number(process.env.TRADINGVIEW_ENTRY_MAX_AGE_SECONDS ?? 120);
  return Number.isFinite(seconds) && seconds >= 1 && seconds <= 900 ? seconds * 1000 : 120_000;
})();

function clientOrderId(accountCycleId: number, sourceCycleId: number) {
  return `tv-${accountCycleId}-${createHash('sha256').update(`tradingview:${sourceCycleId}:${accountCycleId}`).digest('hex').slice(0, 24)}`;
}

function refusalCode(error: unknown) {
  if (!(error instanceof HttpError) || error.statusCode >= 500) return null;
  return error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    && typeof (error.details as Record<string, unknown>).code === 'string'
    ? (error.details as Record<string, unknown>).code as string
    : 'ENTRY_ADMISSION_REFUSED';
}

async function refuseCandidate(db: Db, account: { id: number; tradingAccountId: number }, reasonCode: string) {
  return db.$transaction(async tx => {
    const changed = await tx.externalSignalTradeCycleAccount.updateMany({
      where: { id: account.id, status: 'ENTRY_EXECUTION_PROSPECTIVE' },
      // BLOCKED is deliberately nonterminal. The reason is durable event evidence; terminal fields
      // are reserved for a proved no-exposure lifecycle conclusion.
      data: { status: 'BLOCKED' },
    });
    if (changed.count === 1) await tx.systemEvent.create({ data: {
      type: 'TRADINGVIEW_ENTRY_ADMISSION_REFUSED', entityType: 'ExternalSignalTradeCycleAccount',
      entityId: String(account.id), tradingAccountId: account.tradingAccountId, severity: 'WARNING',
      message: 'Prospective TradingView ENTRY admission was permanently refused before intent creation.',
      payloadJson: { accountCycleId: account.id, reasonCode, orderIntentCreated: false, automaticallyRetryable: false },
    } });
    return changed.count === 1;
  });
}

export async function processProspectiveTradingViewEntries(options: { limit?: number; db?: Db; now?: Date; maxAgeMs?: number } = {}) {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const maxAgeMs = options.maxAgeMs ?? TRADINGVIEW_ENTRY_MAX_AGE_MS;
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const candidates = await db.externalSignalTradeCycleAccount.findMany({
    where: { status: 'ENTRY_EXECUTION_PROSPECTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit,
    include: { tradeCycle: true, entryRoute: { include: { routingRun: { include: { signal: true } } } } },
  });
  let admitted = 0, refused = 0, retryable = 0;
  for (const account of candidates) {
    try {
      const signal = account.entryRoute.routingRun.signal;
      if (now.getTime() - signal.createdAt.getTime() > maxAgeMs) {
        if (await refuseCandidate(db, account, 'ENTRY_SIGNAL_EXPIRED')) refused += 1;
        continue;
      }
      if (account.entryRolloutGenerationId === null || signal.strategySignalRevisionId === null || signal.strategyRevision === null) {
        if (await refuseCandidate(db, account, 'INCOMPLETE_EXECUTION_IDENTITY')) refused += 1;
        continue;
      }
      const authorization = await db.externalSignalEntryExecutionAuthorization.findFirst({
      where: {
        status: 'AUTHORIZED', rolloutGenerationId: account.entryRolloutGenerationId!, tradingAccountId: account.tradingAccountId,
        tradingAccountSubscriptionId: account.tradingAccountSubscriptionId, subscriptionId: account.subscriptionId,
        securityId: account.securityId, signalSourceId: signal.signalSourceId, strategySignalBindingId: signal.strategySignalBindingId,
        strategySignalRevisionId: signal.strategySignalRevisionId, strategyRevision: signal.strategyRevision,
      }, orderBy: { id: 'desc' },
      });
      if (!authorization) {
        if (await refuseCandidate(db, account, 'EXECUTION_AUTHORIZATION_NOT_EFFECTIVE')) refused += 1;
        continue;
      }
      await submitOrder({ tradingAccountSubscriptionId: account.tradingAccountSubscriptionId, signalType: 'entry', extendedHours: false }, {
        clientOrderId: clientOrderId(account.id, account.externalSignalTradeCycleId),
        tradingViewExecution: {
          accountCycleId: account.id, sourceCycleId: account.externalSignalTradeCycleId, entrySignalId: signal.id,
          entrySignalRouteId: account.entrySignalRouteId, authorizationId: authorization.id,
          rolloutGenerationId: authorization.rolloutGenerationId,
          maxSignalAgeMs: maxAgeMs,
        },
      });
      admitted += 1;
    } catch (error) {
      const current = await db.externalSignalTradeCycleAccount.findUnique({ where: { id: account.id }, include: { entryOrderIntent: true } });
      if (current?.status === 'ENTRY_INTENT_CREATED' && current.entryOrderIntent && ['blocked', 'failed'].includes(current.entryOrderIntent.status)) {
        const reconciled = await reconcileReleasedTradingViewAdmissionCyclesForAccount(account.tradingAccountId, { db });
        if (reconciled.terminalized > 0) { refused += 1; continue; }
        await db.systemEvent.create({ data: { type: 'TRADINGVIEW_ENTRY_ADMISSION_RECOVERY_NEEDED', entityType: 'ExternalSignalTradeCycleAccount', entityId: String(account.id), tradingAccountId: account.tradingAccountId, severity: 'WARNING', message: 'TradingView admission created an intent but post-intent processing did not complete successfully.', payloadJson: { accountCycleId: account.id, orderIntentId: current.entryOrderIntent.id, status: current.entryOrderIntent.status, quarantinedFromBrokerDispatch: true } } });
        await db.operationalAttention.upsert({
          where: { activeKey: `TRADINGVIEW_ENTRY_ADMISSION_RECOVERY:${account.id}` },
          create: {
            tradingAccountId: account.tradingAccountId, code: 'TRADINGVIEW_ENTRY_ADMISSION_RECOVERY_REQUIRED', source: 'WORKER',
            status: 'OPEN', severity: 'WARNING', title: 'TradingView entry admission needs recovery',
            message: 'An admitted TradingView intent has unresolved exposure ownership and remains quarantined from broker dispatch.',
            detailsJson: { accountCycleId: account.id, orderIntentId: current.entryOrderIntent.id, quarantinedFromBrokerDispatch: true },
            fingerprint: `TRADINGVIEW_ENTRY_ADMISSION_RECOVERY:${account.id}`, activeKey: `TRADINGVIEW_ENTRY_ADMISSION_RECOVERY:${account.id}`,
            materialFingerprint: `${current.entryOrderIntent.id}:${current.entryOrderIntent.status}`, resolutionPolicy: 'AUTHORITATIVE_ONLY',
            orderIntentId: current.entryOrderIntent.id,
          },
          update: { occurrenceCount: { increment: 1 }, lastObservedAt: new Date(), detailsJson: { accountCycleId: account.id, orderIntentId: current.entryOrderIntent.id, quarantinedFromBrokerDispatch: true } },
        });
        refused += 1;
      } else if (refusalCode(error)) {
        if (await refuseCandidate(db, account, refusalCode(error)!)) refused += 1;
      } else {
        retryable += 1;
      }
    }
  }
  return { examined: candidates.length, admitted, refused, retryable, workerId: randomUUID() };
}

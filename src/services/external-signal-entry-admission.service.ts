import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { submitOrder } from './place-order.service.js';

type Db = PrismaClient;

function clientOrderId(accountCycleId: number, sourceCycleId: number) {
  return `tv-${accountCycleId}-${createHash('sha256').update(`tradingview:${sourceCycleId}:${accountCycleId}`).digest('hex').slice(0, 24)}`;
}

export async function processProspectiveTradingViewEntries(options: { limit?: number; db?: Db } = {}) {
  const db = options.db ?? prisma;
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const candidates = await db.externalSignalTradeCycleAccount.findMany({
    where: { status: 'ENTRY_EXECUTION_PROSPECTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit,
    include: { tradeCycle: true, entryRoute: { include: { routingRun: { include: { signal: true } } } } },
  });
  let admitted = 0, refused = 0, retryable = 0;
  for (const account of candidates) {
    if (account.entryRolloutGenerationId === null) { refused += 1; continue; }
    const signal = account.entryRoute.routingRun.signal;
    if (signal.strategySignalRevisionId === null || signal.strategyRevision === null) { refused += 1; continue; }
    const authorization = await db.externalSignalEntryExecutionAuthorization.findFirst({
      where: {
        status: 'AUTHORIZED', rolloutGenerationId: account.entryRolloutGenerationId!, tradingAccountId: account.tradingAccountId,
        tradingAccountSubscriptionId: account.tradingAccountSubscriptionId, subscriptionId: account.subscriptionId,
        securityId: account.securityId, signalSourceId: signal.signalSourceId, strategySignalBindingId: signal.strategySignalBindingId,
        strategySignalRevisionId: signal.strategySignalRevisionId, strategyRevision: signal.strategyRevision,
      }, orderBy: { id: 'desc' },
    });
    if (!authorization) {
      const changed = await db.externalSignalTradeCycleAccount.updateMany({ where: { id: account.id, status: 'ENTRY_EXECUTION_PROSPECTIVE' }, data: { status: 'BLOCKED', terminalReasonCode: 'EXECUTION_AUTHORIZATION_NOT_EFFECTIVE' } });
      if (changed.count === 1) await db.systemEvent.create({ data: { type: 'TRADINGVIEW_ENTRY_ADMISSION_REFUSED', entityType: 'ExternalSignalTradeCycleAccount', entityId: String(account.id), tradingAccountId: account.tradingAccountId, severity: 'WARNING', message: 'Prospective TradingView ENTRY admission was refused because its exact execution authorization is no longer effective.', payloadJson: { accountCycleId: account.id, reasonCode: 'EXECUTION_AUTHORIZATION_NOT_EFFECTIVE', orderIntentCreated: false } } });
      refused += 1; continue;
    }
    try {
      await submitOrder({ tradingAccountSubscriptionId: account.tradingAccountSubscriptionId, signalType: 'entry', extendedHours: false }, {
        clientOrderId: clientOrderId(account.id, account.externalSignalTradeCycleId),
        tradingViewExecution: {
          accountCycleId: account.id, sourceCycleId: account.externalSignalTradeCycleId, entrySignalId: signal.id,
          entrySignalRouteId: account.entrySignalRouteId, authorizationId: authorization.id,
          rolloutGenerationId: authorization.rolloutGenerationId,
        },
      });
      admitted += 1;
    } catch (error) {
      const current = await db.externalSignalTradeCycleAccount.findUnique({ where: { id: account.id }, include: { entryOrderIntent: true } });
      if (current?.status === 'ENTRY_INTENT_CREATED' && current.entryOrderIntent?.status === 'failed') {
        await db.systemEvent.create({ data: { type: 'TRADINGVIEW_ENTRY_ADMISSION_RECOVERY_NEEDED', entityType: 'ExternalSignalTradeCycleAccount', entityId: String(account.id), tradingAccountId: account.tradingAccountId, severity: 'WARNING', message: 'TradingView admission created an intent but post-intent processing did not complete successfully.', payloadJson: { accountCycleId: account.id, orderIntentId: current.entryOrderIntent.id, status: current.entryOrderIntent.status, quarantinedFromBrokerDispatch: true } } });
        refused += 1;
      } else if (error instanceof HttpError && error.statusCode < 500) {
        const code = error.details && typeof error.details === 'object' && !Array.isArray(error.details) && typeof (error.details as Record<string, unknown>).code === 'string' ? (error.details as Record<string, unknown>).code as string : 'ENTRY_ADMISSION_REFUSED';
        const changed = await db.externalSignalTradeCycleAccount.updateMany({ where: { id: account.id, status: 'ENTRY_EXECUTION_PROSPECTIVE' }, data: { status: 'BLOCKED', terminalReasonCode: code } });
        if (changed.count === 1) await db.systemEvent.create({ data: { type: 'TRADINGVIEW_ENTRY_ADMISSION_REFUSED', entityType: 'ExternalSignalTradeCycleAccount', entityId: String(account.id), tradingAccountId: account.tradingAccountId, severity: 'WARNING', message: 'Prospective TradingView ENTRY admission was refused before intent creation.', payloadJson: { accountCycleId: account.id, reasonCode: code, orderIntentCreated: false, acceptedExitPreemptionChecked: true } } });
        refused += 1;
      } else {
        retryable += 1;
      }
    }
  }
  return { examined: candidates.length, admitted, refused, retryable, workerId: randomUUID() };
}

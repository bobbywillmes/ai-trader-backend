import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { evaluateStrategyEligibility } from './strategy-market-eligibility.service.js';

export const SIGNAL_ROUTE_MARKET_ELIGIBILITY_VERSION = 'SIGNAL_ROUTE_MARKET_ELIGIBILITY_V1';
export const SIGNAL_ROUTE_MARKET_ELIGIBILITY_MAX_ATTEMPTS = 3;

export const routeMarketEligibilityAttemptInclude = {
  eligibilityDecision: {
    include: {
      policyRevision: { select: { id: true, revision: true, activatedAt: true } },
      marketRegimeAssessment: { select: { id: true, compositionVersion: true, targetAt: true, observedAt: true } },
      gates: { orderBy: { ordinal: 'asc' as const } },
    },
  },
} satisfies Prisma.SignalRouteMarketEligibilityAttemptInclude;

function diagnostic(error: unknown) {
  return error instanceof Error ? { errorType: error.constructor.name, message: error.message.slice(0, 500) } : { errorType: 'UnknownError' };
}

async function appendTerminal(signalRouteId: number, args: {
  strategyId: number; status: 'COMPLETED' | 'FAILED' | 'NOT_APPLICABLE'; decisionId?: number;
  reasonCode: string; startedAt: Date; evidenceJson: Prisma.InputJsonObject;
}, client: typeof prisma = prisma) {
  return client.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "SignalRoute" WHERE id = ${signalRouteId} FOR UPDATE`;
    const attempts = await tx.signalRouteMarketEligibilityAttempt.findMany({ where: { signalRouteId }, orderBy: { attempt: 'desc' }, take: 1 });
    const terminal = await tx.signalRouteMarketEligibilityAttempt.findFirst({ where: { signalRouteId, status: { in: ['COMPLETED', 'NOT_APPLICABLE'] } }, include: routeMarketEligibilityAttemptInclude });
    if (terminal) return terminal;
    const attempt = (attempts[0]?.attempt ?? 0) + 1;
    if (attempt > SIGNAL_ROUTE_MARKET_ELIGIBILITY_MAX_ATTEMPTS) return attempts[0]!;
    const row = await tx.signalRouteMarketEligibilityAttempt.create({ data: {
      signalRouteId, attempt, integrationVersion: SIGNAL_ROUTE_MARKET_ELIGIBILITY_VERSION,
      status: args.status, strategyId: args.strategyId, eligibilityDecisionId: args.decisionId ?? null,
      reasonCode: args.reasonCode, startedAt: args.startedAt, completedAt: new Date(), evidenceJson: args.evidenceJson,
    }, include: routeMarketEligibilityAttemptInclude });
    if (args.status === 'FAILED' && attempt === 1) await tx.systemEvent.create({ data: {
      type: 'external_signal_market_eligibility_shadow_failed', entityType: 'signal_route', entityId: String(signalRouteId),
      severity: 'WARNING', message: 'External signal market-policy shadow evaluation failed without changing signal applicability.',
      payloadJson: { signalRouteId, attempt, reasonCode: args.reasonCode },
    } });
    if (args.status === 'COMPLETED' && attempts[0]?.status === 'FAILED') await tx.systemEvent.create({ data: {
      type: 'external_signal_market_eligibility_shadow_recovered', entityType: 'signal_route', entityId: String(signalRouteId),
      severity: 'INFO', message: 'External signal market-policy shadow evaluation recovered.',
      payloadJson: { signalRouteId, attempt, eligibilityDecisionId: args.decisionId },
    } });
    return row;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function processSignalRouteMarketEligibility(signalRouteId: number, client: typeof prisma = prisma, clock: () => Date = () => new Date(), evaluate = evaluateStrategyEligibility) {
  const startedAt = clock();
  const route = await client.signalRoute.findUnique({ where: { id: signalRouteId }, include: { routingRun: { include: { signal: true } }, marketEligibilityAttempts: { orderBy: { attempt: 'desc' }, take: 1 } } });
  if (!route) return null;
  const latest = route.marketEligibilityAttempts[0];
  if (latest && ['COMPLETED', 'NOT_APPLICABLE'].includes(latest.status)) return client.signalRouteMarketEligibilityAttempt.findUnique({ where: { id: latest.id }, include: routeMarketEligibilityAttemptInclude });
  if ((latest?.attempt ?? 0) >= SIGNAL_ROUTE_MARKET_ELIGIBILITY_MAX_ATTEMPTS) return client.signalRouteMarketEligibilityAttempt.findUnique({ where: { id: latest!.id }, include: routeMarketEligibilityAttemptInclude });
  const signal = route.routingRun.signal;
  if (signal.event === 'EXIT_LONG') return appendTerminal(signalRouteId, { strategyId: signal.strategyId, status: 'NOT_APPLICABLE', reasonCode: 'ENTRY_POLICY_NOT_APPLICABLE_TO_EXIT', startedAt, evidenceJson: { event: signal.event, tradingEffect: 'NONE' } }, client);
  try {
    const decision = await evaluate(signal.strategyId, { evaluatedAt: startedAt, contextType: 'SIGNAL_ROUTE', contextIdentity: `SIGNAL_ROUTE:${signalRouteId}`, db: client });
    return appendTerminal(signalRouteId, { strategyId: signal.strategyId, status: 'COMPLETED', decisionId: decision.id, reasonCode: 'SHADOW_EVALUATION_COMPLETED', startedAt, evidenceJson: { signalId: signal.id, signalRouteId, signalEvaluationVersion: route.evaluationVersion, recordedOutcome: decision.outcome, tradingEffect: 'NONE' } }, client);
  } catch (error) {
    return appendTerminal(signalRouteId, { strategyId: signal.strategyId, status: 'FAILED', reasonCode: 'SHADOW_PROCESSING_FAILED', startedAt, evidenceJson: { signalId: signal.id, signalRouteId, ...diagnostic(error), tradingEffect: 'NONE' } }, client);
  }
}

export async function processSignalMarketEligibilityRoutes(signalId: number, client: typeof prisma = prisma) {
  const routes = await client.signalRoute.findMany({ where: { routingRun: { signalId } }, select: { id: true } });
  return Promise.all(routes.map(route => processSignalRouteMarketEligibility(route.id, client)));
}

import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { externalSignalSourceSelect, bindingRevisionInclude } from './external-signal-config.service.js';
import type { ExternalSignalListFilters } from '../validators/external-signal.schema.js';
import { routingRunInclude } from './signal-routing.service.js';
import { evaluationInclude } from './signal-evaluation.service.js';
import { routeMarketEligibilityAttemptInclude } from './signal-route-market-eligibility.service.js';

export type ExternalSignalResource = 'sources' | 'bindings' | 'deliveries' | 'signals';

async function presentSignalRouteShadowFreshness(signal: any) {
  if (!signal?.routingRun) return signal;
  const at = new Date();
  const [active, composition] = await Promise.all([
    prisma.strategyMarketPolicyRevision.findFirst({ where: { policy: { strategyId: signal.strategyId }, status: 'ACTIVE' }, select: { id: true } }),
    prisma.marketRegimeAssessment.findFirst({ where: { observedAt: { lte: at } }, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], select: { id: true } }),
  ]);
  return { ...signal, routingRun: { ...signal.routingRun, routes: signal.routingRun.routes.map((route: any) => ({ ...route,
    marketEligibilityAttempts: route.marketEligibilityAttempts.map((attempt: any) => attempt.eligibilityDecision ? { ...attempt,
      eligibilityDecision: { ...attempt.eligibilityDecision,
        currentFreshness: attempt.eligibilityDecision.policyRevisionId !== (active?.id ?? null) ? 'POLICY_SUPERSEDED'
          : attempt.eligibilityDecision.marketRegimeAssessmentId !== (composition?.id ?? null) ? 'COMPOSITION_SUPERSEDED'
          : attempt.eligibilityDecision.validUntil && attempt.eligibilityDecision.validUntil.getTime() <= at.getTime() ? 'EXPIRED' : 'CURRENT',
      },
    } : attempt),
  })) } };
}

export async function getExternalSignalResource(resource: ExternalSignalResource, id: number) {
  const where = { id };
  const result = resource === 'sources'
    ? await prisma.externalSignalSource.findUnique({ where, select: externalSignalSourceSelect })
    : resource === 'bindings' ? await prisma.strategySignalBinding.findUnique({ where, include: bindingRevisionInclude })
    : resource === 'deliveries' ? await prisma.signalDelivery.findUnique({ where })
    : await prisma.signal.findUnique({ where, include: { strategySignalRevision: true, routingRun: { include: {
      routes: { ...routingRunInclude.routes, include: { evaluation: { include: evaluationInclude }, marketEligibilityAttempts: { include: routeMarketEligibilityAttemptInclude, orderBy: { attempt: 'asc' } } } },
    } } } });
  if (!result) throw new HttpError(404, 'Resource not found.');
  return resource === 'signals' ? presentSignalRouteShadowFreshness(result) : result;
}

export async function listExternalSignalResources(resource: ExternalSignalResource, filters: ExternalSignalListFilters) {
  const { page, pageSize, signalSourceId, strategyId, securityId, signalId, symbol, event,
    timeframe, status, rejectionCode, from, to } = filters;
  const range = { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
  const options = { skip: (page - 1) * pageSize, take: pageSize, orderBy: { id: 'desc' as const } };
  let rows: unknown[];
  let total: number;
  if (resource === 'sources') {
    const where = signalSourceId ? { id: signalSourceId } : {};
    [rows, total] = await Promise.all([
      prisma.externalSignalSource.findMany({ ...options, where, select: externalSignalSourceSelect }),
      prisma.externalSignalSource.count({ where }),
    ]);
  } else if (resource === 'bindings') {
    const where = { ...(signalSourceId ? { signalSourceId } : {}), ...(strategyId ? { strategyId } : {}) };
    [rows, total] = await Promise.all([
      prisma.strategySignalBinding.findMany({ ...options, where, include: bindingRevisionInclude }), prisma.strategySignalBinding.count({ where }),
    ]);
  } else if (resource === 'deliveries') {
    const where: Prisma.SignalDeliveryWhereInput = {
      ...(signalSourceId ? { signalSourceId } : {}), ...(signalId ? { signalId } : {}),
      ...(status ? { status } : {}), ...(rejectionCode ? { rejectionCode } : {}), receivedAt: range,
    };
    [rows, total] = await Promise.all([
      prisma.signalDelivery.findMany({ ...options, where }), prisma.signalDelivery.count({ where }),
    ]);
  } else {
    const where: Prisma.SignalWhereInput = {
      ...(signalSourceId ? { signalSourceId } : {}), ...(strategyId ? { strategyId } : {}),
      ...(securityId ? { securityId } : {}), ...(symbol ? { symbol } : {}),
      ...(event ? { event } : {}), ...(timeframe ? { timeframe } : {}), signalTime: range,
    };
    [rows, total] = await Promise.all([
      prisma.signal.findMany({ ...options, where }), prisma.signal.count({ where }),
    ]);
  }
  return { [resource]: rows, pagination: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) } };
}

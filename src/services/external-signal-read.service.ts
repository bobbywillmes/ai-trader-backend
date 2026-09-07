import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { externalSignalSourceSelect } from './external-signal-config.service.js';
import type { ExternalSignalListFilters } from '../validators/external-signal.schema.js';

export type ExternalSignalResource = 'sources' | 'bindings' | 'deliveries' | 'signals';

export async function getExternalSignalResource(resource: ExternalSignalResource, id: number) {
  const where = { id };
  const result = resource === 'sources'
    ? await prisma.externalSignalSource.findUnique({ where, select: externalSignalSourceSelect })
    : resource === 'bindings' ? await prisma.strategySignalBinding.findUnique({ where })
    : resource === 'deliveries' ? await prisma.signalDelivery.findUnique({ where })
    : await prisma.signal.findUnique({ where });
  if (!result) throw new HttpError(404, 'Resource not found.');
  return result;
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
      prisma.strategySignalBinding.findMany({ ...options, where }), prisma.strategySignalBinding.count({ where }),
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

import { OperationalAttentionResolutionPolicy, Prisma, SystemEventSeverity } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { OPERATIONAL_ATTENTION_CODES, OPERATIONAL_ATTENTION_SOURCES, openOrObserveOperationalAttention } from './operational-attention.service.js';
import { createSystemEvent } from './system-event.service.js';

export function unexpectedShortSeverity(environment: 'PAPER' | 'LIVE') {
  if (environment === 'PAPER') return SystemEventSeverity.ERROR;
  return env.NODE_ENV === 'production' && env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR'
    ? SystemEventSeverity.CRITICAL : SystemEventSeverity.WARNING;
}

export function unexpectedShortFingerprint(tradingAccountId: number, symbol: string) {
  return `account:${tradingAccountId}|unexpected-short:${symbol.trim().toUpperCase()}`;
}

export async function observeUnexpectedShortExposure(args: {
  tradingAccountId: number; environment: 'PAPER' | 'LIVE'; symbol: string;
  brokerQty: string | number; brokerSide: string; broker?: string;
  trackedPositionId?: number | null; observedAt?: Date; source?: 'POSITION_SYNC' | 'RECONCILIATION';
}) {
  const symbol = args.symbol.trim().toUpperCase();
  const observedAt = args.observedAt ?? new Date();
  const fingerprint = unexpectedShortFingerprint(args.tradingAccountId, symbol);
  const severity = unexpectedShortSeverity(args.environment);
  const existing = await prisma.operationalAttention.findUnique({ where: { activeKey: fingerprint }, select: { id: true } });
  const evidence = {
    tradingAccountId: args.tradingAccountId, environment: args.environment,
    broker: args.broker ?? 'alpaca', symbol, brokerSide: args.brokerSide,
    brokerQty: args.brokerQty, trackedPositionId: args.trackedPositionId ?? null,
    source: args.source ?? 'POSITION_SYNC', observedAt: observedAt.toISOString(),
    deploymentRole: env.LIVE_WRITE_DEPLOYMENT_ROLE,
    authoritativeProductionExecutor: env.NODE_ENV === 'production' && env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR',
    automatedAction: 'BLOCK_SELLS_NO_AUTO_COVER',
  };
  const event = existing ? null : await createSystemEvent({
    type: 'broker.unexpected_short_position_observed',
    entityType: args.trackedPositionId ? 'trackedPosition' : 'tradingAccount',
    entityId: args.trackedPositionId ?? args.tradingAccountId,
    tradingAccountId: args.tradingAccountId, severity,
    message: `${symbol} is short at Alpaca. AI Trader blocked sell automation and will not automatically buy to cover.`,
    payloadJson: evidence as Prisma.InputJsonValue,
  });
  return openOrObserveOperationalAttention({
    tradingAccountId: args.tradingAccountId,
    ...(args.trackedPositionId ? { trackedPositionId: args.trackedPositionId } : {}),
    code: OPERATIONAL_ATTENTION_CODES.UNEXPECTED_SHORT_POSITION,
    source: OPERATIONAL_ATTENTION_SOURCES.RECONCILIATION, severity,
    title: `Unexpected short exposure: ${symbol}`,
    message: args.environment === 'LIVE' && severity !== SystemEventSeverity.CRITICAL
      ? 'Observation-only deployment detected Live short exposure. Review authoritative broker and reconciliation evidence; this deployment cannot correct it.'
      : 'Broker-reported short exposure blocks all sell automation. Review authoritative broker and reconciliation evidence.',
    details: evidence, fingerprint,
    resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY,
    observedAt, observedSystemEventId: event?.id ?? null,
  });
}

import { OperationalAttentionResolutionPolicy, SystemEventSeverity } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { WorkerKey } from '../workers/worker-health.definitions.js';
import { OPERATIONAL_ATTENTION_CODES, OPERATIONAL_ATTENTION_SOURCES, openOrObserveOperationalAttention, resolveOperationalAttentionAuthoritatively } from './operational-attention.service.js';

export function workerAttentionFingerprint(tradingAccountId: number, workerKey: WorkerKey) { return `account:${tradingAccountId}|worker:${workerKey}`; }

export async function projectWorkerOperationalAttention(args: {
  tradingAccountId: number; workerKey: WorkerKey; displayName: string; environment: 'PAPER' | 'LIVE';
  recovered: boolean; nextStatus: string; reason: string | null; eventId?: number;
  activePositionCount: number; unresolvedOrderCount: number; pendingFillAttributionCount: number;
}) {
  const fingerprint = workerAttentionFingerprint(args.tradingAccountId, args.workerKey);
  if (args.recovered) {
    const active = await prisma.operationalAttention.findUnique({ where: { activeKey: fingerprint } });
    if (active?.source === OPERATIONAL_ATTENTION_SOURCES.WORKER) await resolveOperationalAttentionAuthoritatively({ id: active.id, expectedRevision: active.revision, reason: 'Current account-worker evidence is healthy and fresh.', evidence: { workerKey: args.workerKey, recovered: true, status: args.nextStatus } });
    return;
  }
  const consequence = args.activePositionCount + args.unresolvedOrderCount + args.pendingFillAttributionCount > 0;
  if (!consequence || !['FAILING', 'STALE'].includes(args.nextStatus)) return;
  const critical = args.nextStatus === 'STALE' && args.environment === 'LIVE' && env.NODE_ENV === 'production' && env.LIVE_WRITE_DEPLOYMENT_ROLE === 'PRODUCTION_EXECUTOR';
  await openOrObserveOperationalAttention({
    tradingAccountId: args.tradingAccountId, code: OPERATIONAL_ATTENTION_CODES.ACCOUNT_WORKER_UNHEALTHY, source: OPERATIONAL_ATTENTION_SOURCES.WORKER,
    severity: critical ? SystemEventSeverity.CRITICAL : SystemEventSeverity.ERROR,
    title: `${args.displayName} ${args.workerKey.replaceAll('_', ' ')} is ${args.nextStatus.toLowerCase()}`,
    message: `The worker is ${args.nextStatus.toLowerCase()} while responsible for current exposure or unresolved order state.`,
    details: { workerKey: args.workerKey, status: args.nextStatus, reason: args.reason, activePositionCount: args.activePositionCount, unresolvedOrderCount: args.unresolvedOrderCount, pendingFillAttributionCount: args.pendingFillAttributionCount },
    fingerprint, resolutionPolicy: OperationalAttentionResolutionPolicy.AUTHORITATIVE_ONLY,
    observedSystemEventId: args.eventId ?? null,
  });
}

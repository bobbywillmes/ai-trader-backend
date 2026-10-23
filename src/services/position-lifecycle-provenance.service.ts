import { createHash } from 'node:crypto';
import {
  PositionLifecycleOrigin,
  PositionLifecycleOwnership,
  Prisma,
} from '@prisma/client';

import { prisma } from '../db/prisma.js';

export const POSITION_LIFECYCLE_PROVENANCE_SCHEMA_VERSION =
  'POSITION_LIFECYCLE_PROVENANCE_V1' as const;

type DecisionActor =
  | { type: 'SYSTEM' }
  | { type: 'USER'; userId: number };

export type RecordPositionLifecycleProvenanceDecisionArgs = {
  trackedPositionId: number;
  tradingAccountId: number;
  origin: PositionLifecycleOrigin;
  ownership: PositionLifecycleOwnership;
  legacyExitContinuityAuthorized?: boolean;
  classifierVersion: string;
  evidence: Prisma.InputJsonObject;
  actor: DecisionActor;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function positionLifecycleEvidenceFingerprint(
  args: Omit<RecordPositionLifecycleProvenanceDecisionArgs, 'actor'>,
) {
  return createHash('sha256').update(canonicalJson({
    schemaVersion: POSITION_LIFECYCLE_PROVENANCE_SCHEMA_VERSION,
    trackedPositionId: args.trackedPositionId,
    tradingAccountId: args.tradingAccountId,
    origin: args.origin,
    ownership: args.ownership,
    legacyExitContinuityAuthorized:
      args.legacyExitContinuityAuthorized ?? false,
    classifierVersion: args.classifierVersion,
    evidence: args.evidence,
  })).digest('hex');
}

/**
 * Phase 1A controlled append path. It records evidence only and is intentionally
 * disconnected from synchronization, evaluation, reconciliation, and broker flows.
 */
export async function recordPositionLifecycleProvenanceDecision(
  args: RecordPositionLifecycleProvenanceDecisionArgs,
) {
  return prisma.$transaction(async (tx) => {
    const positions = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM "TrackedPosition"
      WHERE id = ${args.trackedPositionId}
        AND "tradingAccountId" = ${args.tradingAccountId}
      FOR UPDATE
    `;
    if (positions.length !== 1) {
      throw new Error('TrackedPosition and TradingAccount provenance identity is inconsistent.');
    }

    const heads = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT current_decision.id
      FROM "PositionLifecycleProvenanceDecision" current_decision
      WHERE current_decision."trackedPositionId" = ${args.trackedPositionId}
        AND NOT EXISTS (
          SELECT 1 FROM "PositionLifecycleProvenanceDecision" successor
          WHERE successor."supersedesDecisionId" = current_decision.id
        )
      ORDER BY current_decision.id DESC
      LIMIT 1
      FOR UPDATE
    `;

    const fingerprintArgs = {
      trackedPositionId: args.trackedPositionId,
      tradingAccountId: args.tradingAccountId,
      origin: args.origin,
      ownership: args.ownership,
      legacyExitContinuityAuthorized:
        args.legacyExitContinuityAuthorized ?? false,
      classifierVersion: args.classifierVersion,
      evidence: args.evidence,
    };

    return tx.positionLifecycleProvenanceDecision.create({
      data: {
        trackedPositionId: args.trackedPositionId,
        tradingAccountId: args.tradingAccountId,
        origin: args.origin,
        ownership: args.ownership,
        legacyExitContinuityAuthorized:
          args.legacyExitContinuityAuthorized ?? false,
        classifierVersion: args.classifierVersion,
        evidenceJson: args.evidence,
        evidenceFingerprint:
          positionLifecycleEvidenceFingerprint(fingerprintArgs),
        actorType: args.actor.type,
        actorUserId: args.actor.type === 'USER' ? args.actor.userId : null,
        supersedesDecisionId: heads[0]?.id ?? null,
      },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

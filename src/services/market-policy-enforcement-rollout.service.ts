import { PlatformRole, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { createSystemEvent } from './system-event.service.js';

// Phase 3C.2 runtime switch for authoritative PAPER pre-intent market-policy enforcement. It is
// created disabled by migration, is separate from per-assignment authorization, and is never
// inferred from ACTIVE enrollments or AUTHORIZED grants. It confers no LIVE authority and does not
// implement broker-time enforcement (Phase 3C.3).
export const MARKET_POLICY_ENFORCEMENT_ROLLOUT_ID = 1;

type Db = typeof prisma | Prisma.TransactionClient;

const changedBySelect = { select: { id: true, email: true, name: true } } as const;

export type MarketPolicyEnforcementRuntimeStatus = {
  environment: 'PAPER';
  active: boolean;
  status: 'ACTIVE' | 'NOT_ACTIVATED' | 'DEACTIVATED' | 'UNAVAILABLE';
  version: number;
  changedAt: Date | null;
  changedBy: { id: number; email: string; name: string | null } | null;
  changeReason: string | null;
  tradingEffect: 'PAPER_PRE_INTENT_ENFORCEMENT' | 'NONE';
  liveAuthority: 'NONE';
  brokerTimeEnforcement: 'NOT_IMPLEMENTED';
};

export async function getMarketPolicyEnforcementRuntimeStatus(db: Db = prisma): Promise<MarketPolicyEnforcementRuntimeStatus> {
  const row = await db.marketPolicyEnforcementRuntimeRollout.findUnique({ where: { id: MARKET_POLICY_ENFORCEMENT_ROLLOUT_ID }, include: { changedBy: changedBySelect } });
  const base = { environment: 'PAPER' as const, liveAuthority: 'NONE' as const, brokerTimeEnforcement: 'NOT_IMPLEMENTED' as const };
  if (!row) return { ...base, active: false, status: 'UNAVAILABLE', version: 0, changedAt: null, changedBy: null, changeReason: null, tradingEffect: 'NONE' };
  return {
    ...base,
    active: row.enabled,
    status: row.enabled ? 'ACTIVE' : row.version === 0 ? 'NOT_ACTIVATED' : 'DEACTIVATED',
    version: row.version,
    changedAt: row.changedAt,
    changedBy: row.changedBy,
    changeReason: row.changeReason,
    tradingEffect: row.enabled ? 'PAPER_PRE_INTENT_ENFORCEMENT' : 'NONE',
  };
}

// Non-owner projection: rollout state without the changing owner's identity or reason.
export function redactMarketPolicyEnforcementRuntimeStatus(status: MarketPolicyEnforcementRuntimeStatus) {
  const { changedBy: _changedBy, changeReason: _changeReason, ...rest } = status;
  return rest;
}

/**
 * Locks the rollout row FOR SHARE inside an entry-admission transaction. Activation and
 * deactivation take FOR UPDATE, so a rollout change never commits mid-admission. This is the first
 * lock in the admission lock order.
 */
export async function lockMarketPolicyEnforcementRollout(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ enabled: boolean; version: number }>>`
    SELECT enabled, version FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = ${MARKET_POLICY_ENFORCEMENT_ROLLOUT_ID} FOR SHARE`;
  // A missing row (an unmigrated database) can only mean the rollout was never activated.
  return row ?? { enabled: false, version: 0 };
}

export type SetMarketPolicyEnforcementRolloutInput = { expectedVersion: number; reason: string };

export async function setMarketPolicyEnforcementRuntimeRollout(enabled: boolean, input: SetMarketPolicyEnforcementRolloutInput, actorUserId: number) {
  try {
    return await prisma.$transaction(async tx => {
      const [actor] = await tx.$queryRaw<Array<{ platformRole: string; enabled: boolean }>>`SELECT "platformRole"::text AS "platformRole", enabled FROM "User" WHERE id = ${actorUserId} FOR SHARE`;
      if (!actor || !actor.enabled || actor.platformRole !== PlatformRole.SYSTEM_OWNER) throw new HttpError(403, 'SYSTEM_OWNER authorization is required.', { code: 'SYSTEM_OWNER_REQUIRED' });
      const [row] = await tx.$queryRaw<Array<{ enabled: boolean; version: number }>>`
        SELECT enabled, version FROM "MarketPolicyEnforcementRuntimeRollout" WHERE id = ${MARKET_POLICY_ENFORCEMENT_ROLLOUT_ID} FOR UPDATE`;
      if (!row) throw new HttpError(409, 'The market-policy enforcement rollout is not installed.', { code: 'ROLLOUT_UNAVAILABLE' });
      if (row.version !== input.expectedVersion) throw new HttpError(409, 'The rollout changed after it was loaded; reload and retry.', { code: 'STALE_ROLLOUT_VERSION', currentVersion: row.version });
      if (row.enabled === enabled) throw new HttpError(409, enabled ? 'PAPER market-policy enforcement is already active.' : 'PAPER market-policy enforcement is already inactive.', { code: enabled ? 'ROLLOUT_ALREADY_ACTIVE' : 'ROLLOUT_ALREADY_INACTIVE' });
      // changedAt is stamped by PostgreSQL, which also writes the immutable rollout event.
      await tx.marketPolicyEnforcementRuntimeRollout.update({
        where: { id: MARKET_POLICY_ENFORCEMENT_ROLLOUT_ID },
        data: { enabled, version: row.version + 1, changedByUserId: actorUserId, changeReason: input.reason },
      });
      const status = await getMarketPolicyEnforcementRuntimeStatus(tx);
      await createSystemEvent({
        type: enabled ? 'MARKET_POLICY_ENFORCEMENT_RUNTIME_ACTIVATED' : 'MARKET_POLICY_ENFORCEMENT_RUNTIME_DEACTIVATED',
        entityType: 'MarketPolicyEnforcementRuntimeRollout', entityId: MARKET_POLICY_ENFORCEMENT_ROLLOUT_ID, actorUserId, severity: 'WARNING',
        message: enabled
          ? 'PAPER market-policy pre-intent enforcement activated; explicitly authorized PAPER assignments are now market-policy gated.'
          : 'PAPER market-policy pre-intent enforcement deactivated; entries return to existing behavior. Frozen OrderIntent obligations are unchanged.',
        payloadJson: { version: status.version, enabled, environment: 'PAPER', reason: input.reason, liveAuthority: 'NONE', brokerTimeEnforcement: 'NOT_IMPLEMENTED', frozenObligationsAltered: false },
      }, tx);
      return status;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 });
  } catch (error) {
    if (error instanceof Error && /rollout changes require an enabled SYSTEM_OWNER/.test(error.message)) throw new HttpError(403, 'SYSTEM_OWNER authorization is required.', { code: 'SYSTEM_OWNER_REQUIRED' });
    throw error;
  }
}

export async function listMarketPolicyEnforcementRuntimeRolloutEvents(limit = 50) {
  const events = await prisma.marketPolicyEnforcementRuntimeRolloutEvent.findMany({ orderBy: { version: 'desc' }, take: Math.min(Math.max(limit, 1), 200), include: { actor: changedBySelect } });
  return events.map(event => ({ id: event.id, version: event.version, action: event.action, enabled: event.enabled, environment: event.environment, reason: event.reason, actor: event.actor, occurredAt: event.occurredAt }));
}

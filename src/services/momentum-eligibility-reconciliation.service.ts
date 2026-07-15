import { MomentumCandidateState, Prisma } from '@prisma/client';

import { prisma } from '../db/prisma.js';
import { isActiveMomentumCandidateState } from './momentum-candidate-lifecycle.js';
import {
  evaluateMomentumSubscriptionEligibility,
  momentumSubscriptionEligibilitySelect,
} from './momentum-subscription-eligibility.service.js';

const READ_BATCH_SIZE = 500;
const WRITE_BATCH_SIZE = 500;

const securitySelect = {
  id: true,
  symbol: true,
  momentumUniverseMember: {
    select: { enabled: true },
  },
  subscriptions: {
    select: momentumSubscriptionEligibilitySelect,
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.SecuritySelect;

const candidateSelect = {
  id: true,
  symbol: true,
  securityId: true,
  state: true,
  expiresAt: true,
} satisfies Prisma.MomentumCandidateSelect;

const impactSelect = {
  id: true,
  symbol: true,
  securityId: true,
} satisfies Prisma.CatalystTickerImpactSelect;

type SecurityRecord = Prisma.SecurityGetPayload<{ select: typeof securitySelect }>;
type CandidateRecord = Prisma.MomentumCandidateGetPayload<{
  select: typeof candidateSelect;
}>;
type ImpactRecord = Prisma.CatalystTickerImpactGetPayload<{
  select: typeof impactSelect;
}>;

type IdentityResolution =
  | { kind: 'RESOLVED'; security: SecurityRecord; linkRequired: boolean }
  | { kind: 'UNMATCHED' }
  | { kind: 'AMBIGUOUS' }
  | { kind: 'CONFLICTING' };

export type MomentumEligibilityReconciliationPlan = {
  report: {
    mode: 'DRY_RUN' | 'APPLY';
    asOf: Date;
    totalCandidatesInspected: number;
    candidatesResolvedToSecurity: number;
    candidatesUnmatched: number;
    candidatesAmbiguous: number;
    candidatesConflicting: number;
    candidateSecurityLinksToApply: number;
    candidatesInUniverse: number;
    candidatesOutOfUniverse: number;
    candidatesUniverseDisabled: number;
    momentumSubscriptionEligible: number;
    notMomentumSubscriptionEligible: number;
    expiredDueToAge: number;
    markedIneligible: number;
    unchangedHistoricalRecords: number;
    totalTickerImpactsInspected: number;
    tickerImpactsResolvedToSecurity: number;
    tickerImpactsUnmatched: number;
    tickerImpactsAmbiguous: number;
    tickerImpactsConflicting: number;
    tickerImpactSecurityLinksToApply: number;
  };
  candidateSecurityLinks: Array<{ id: string; securityId: number }>;
  tickerImpactSecurityLinks: Array<{ id: string; securityId: number }>;
  candidateIdsToExpire: string[];
};

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

function groupSecuritiesBySymbol(securities: SecurityRecord[]) {
  const result = new Map<string, SecurityRecord[]>();

  for (const security of securities) {
    const symbol = normalizeSymbol(security.symbol);
    result.set(symbol, [...(result.get(symbol) ?? []), security]);
  }

  return result;
}

function resolveIdentity(
  record: { symbol: string; securityId: number | null },
  securitiesById: Map<number, SecurityRecord>,
  securitiesBySymbol: Map<string, SecurityRecord[]>
): IdentityResolution {
  const matches = securitiesBySymbol.get(normalizeSymbol(record.symbol)) ?? [];

  if (record.securityId !== null) {
    const linked = securitiesById.get(record.securityId);

    return linked && normalizeSymbol(linked.symbol) === normalizeSymbol(record.symbol)
      ? { kind: 'RESOLVED', security: linked, linkRequired: false }
      : { kind: 'CONFLICTING' };
  }

  if (matches.length === 0) return { kind: 'UNMATCHED' };
  if (matches.length > 1) return { kind: 'AMBIGUOUS' };

  return { kind: 'RESOLVED', security: matches[0]!, linkRequired: true };
}

export function buildMomentumEligibilityReconciliationPlan(args: {
  candidates: CandidateRecord[];
  tickerImpacts: ImpactRecord[];
  securities: SecurityRecord[];
  now?: Date;
  apply?: boolean;
}): MomentumEligibilityReconciliationPlan {
  const now = args.now ?? new Date();
  const securitiesById = new Map(args.securities.map((item) => [item.id, item]));
  const securitiesBySymbol = groupSecuritiesBySymbol(args.securities);
  const candidateSecurityLinks: Array<{ id: string; securityId: number }> = [];
  const tickerImpactSecurityLinks: Array<{ id: string; securityId: number }> = [];
  const candidateIdsToExpire = new Set<string>();
  const report: MomentumEligibilityReconciliationPlan['report'] = {
    mode: args.apply ? 'APPLY' : 'DRY_RUN',
    asOf: now,
    totalCandidatesInspected: args.candidates.length,
    candidatesResolvedToSecurity: 0,
    candidatesUnmatched: 0,
    candidatesAmbiguous: 0,
    candidatesConflicting: 0,
    candidateSecurityLinksToApply: 0,
    candidatesInUniverse: 0,
    candidatesOutOfUniverse: 0,
    candidatesUniverseDisabled: 0,
    momentumSubscriptionEligible: 0,
    notMomentumSubscriptionEligible: 0,
    expiredDueToAge: 0,
    markedIneligible: 0,
    unchangedHistoricalRecords: 0,
    totalTickerImpactsInspected: args.tickerImpacts.length,
    tickerImpactsResolvedToSecurity: 0,
    tickerImpactsUnmatched: 0,
    tickerImpactsAmbiguous: 0,
    tickerImpactsConflicting: 0,
    tickerImpactSecurityLinksToApply: 0,
  };

  for (const impact of args.tickerImpacts) {
    const resolution = resolveIdentity(impact, securitiesById, securitiesBySymbol);

    if (resolution.kind === 'UNMATCHED') report.tickerImpactsUnmatched += 1;
    if (resolution.kind === 'AMBIGUOUS') report.tickerImpactsAmbiguous += 1;
    if (resolution.kind === 'CONFLICTING') report.tickerImpactsConflicting += 1;
    if (resolution.kind === 'RESOLVED') {
      report.tickerImpactsResolvedToSecurity += 1;
      if (resolution.linkRequired) {
        tickerImpactSecurityLinks.push({ id: impact.id, securityId: resolution.security.id });
      }
    }
  }

  for (const candidate of args.candidates) {
    const resolution = resolveIdentity(candidate, securitiesById, securitiesBySymbol);
    const active = isActiveMomentumCandidateState(candidate.state);
    const stale = active && candidate.expiresAt !== null && candidate.expiresAt <= now;
    let ownershipIneligible = false;

    if (resolution.kind === 'UNMATCHED') {
      report.candidatesUnmatched += 1;
      ownershipIneligible = true;
    }
    if (resolution.kind === 'AMBIGUOUS') {
      report.candidatesAmbiguous += 1;
      ownershipIneligible = true;
    }
    if (resolution.kind === 'CONFLICTING') {
      report.candidatesConflicting += 1;
      ownershipIneligible = true;
    }
    if (resolution.kind === 'RESOLVED') {
      report.candidatesResolvedToSecurity += 1;
      if (resolution.linkRequired) {
        candidateSecurityLinks.push({ id: candidate.id, securityId: resolution.security.id });
      }

      const membership = resolution.security.momentumUniverseMember;
      if (membership === null) {
        report.candidatesOutOfUniverse += 1;
        ownershipIneligible = true;
      } else {
        report.candidatesInUniverse += 1;
        if (!membership.enabled) {
          report.candidatesUniverseDisabled += 1;
          ownershipIneligible = true;
        }
      }

      const subscriptionEligibility = evaluateMomentumSubscriptionEligibility(
        resolution.security.subscriptions
      );
      if (subscriptionEligibility.eligible) {
        report.momentumSubscriptionEligible += 1;
      } else {
        report.notMomentumSubscriptionEligible += 1;
      }
    } else {
      report.notMomentumSubscriptionEligible += 1;
    }

    if (stale) {
      report.expiredDueToAge += 1;
      candidateIdsToExpire.add(candidate.id);
    } else if (active && ownershipIneligible) {
      report.markedIneligible += 1;
      candidateIdsToExpire.add(candidate.id);
    } else {
      report.unchangedHistoricalRecords += 1;
    }
  }

  report.candidateSecurityLinksToApply = candidateSecurityLinks.length;
  report.tickerImpactSecurityLinksToApply = tickerImpactSecurityLinks.length;

  return {
    report,
    candidateSecurityLinks,
    tickerImpactSecurityLinks,
    candidateIdsToExpire: [...candidateIdsToExpire],
  };
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function loadAllSecurities() {
  const rows: SecurityRecord[] = [];
  let cursor: number | undefined;
  do {
    const batch = await prisma.security.findMany({
      select: securitySelect,
      orderBy: { id: 'asc' },
      take: READ_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    rows.push(...batch);
    cursor = batch.at(-1)?.id;
    if (batch.length < READ_BATCH_SIZE) break;
  } while (cursor !== undefined);
  return rows;
}

async function loadAllCandidates() {
  const rows: CandidateRecord[] = [];
  let cursor: string | undefined;
  do {
    const batch = await prisma.momentumCandidate.findMany({
      select: candidateSelect,
      orderBy: { id: 'asc' },
      take: READ_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    rows.push(...batch);
    cursor = batch.at(-1)?.id;
    if (batch.length < READ_BATCH_SIZE) break;
  } while (cursor !== undefined);
  return rows;
}

async function loadAllTickerImpacts() {
  const rows: ImpactRecord[] = [];
  let cursor: string | undefined;
  do {
    const batch = await prisma.catalystTickerImpact.findMany({
      select: impactSelect,
      orderBy: { id: 'asc' },
      take: READ_BATCH_SIZE,
      ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
    });
    rows.push(...batch);
    cursor = batch.at(-1)?.id;
    if (batch.length < READ_BATCH_SIZE) break;
  } while (cursor !== undefined);
  return rows;
}

export async function reconcileMomentumEligibility(args: {
  apply?: boolean;
  now?: Date;
} = {}) {
  const now = args.now ?? new Date();
  const [securities, candidates, tickerImpacts] = await Promise.all([
    loadAllSecurities(),
    loadAllCandidates(),
    loadAllTickerImpacts(),
  ]);
  const plan = buildMomentumEligibilityReconciliationPlan({
    securities,
    candidates,
    tickerImpacts,
    now,
    apply: args.apply ?? false,
  });

  if (!args.apply) return plan.report;

  const operations: Prisma.PrismaPromise<unknown>[] = [];
  for (const link of plan.candidateSecurityLinks) {
    operations.push(
      prisma.momentumCandidate.updateMany({
        where: { id: link.id, securityId: null },
        data: { securityId: link.securityId },
      })
    );
  }
  for (const link of plan.tickerImpactSecurityLinks) {
    operations.push(
      prisma.catalystTickerImpact.updateMany({
        where: { id: link.id, securityId: null },
        data: { securityId: link.securityId },
      })
    );
  }
  for (const ids of chunks(plan.candidateIdsToExpire, WRITE_BATCH_SIZE)) {
    operations.push(
      prisma.momentumCandidate.updateMany({
        where: {
          id: { in: ids },
          state: {
            in: [
              MomentumCandidateState.DISCOVERED,
              MomentumCandidateState.WATCHING,
              MomentumCandidateState.ENTRY_READY,
              MomentumCandidateState.ENTRY_BLOCKED,
            ],
          },
        },
        data: { state: MomentumCandidateState.EXPIRED, lastEvaluatedAt: now },
      })
    );
  }

  if (operations.length > 0) await prisma.$transaction(operations);
  return plan.report;
}

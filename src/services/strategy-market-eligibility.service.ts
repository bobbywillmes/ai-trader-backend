import { createHash } from 'node:crypto';
import { Prisma, type MarketRegimeCompositionSourceHealth } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { STRATEGY_MARKET_POLICY_DIMENSIONS } from './strategy-market-policy.definition.js';

export const STRATEGY_MARKET_ELIGIBILITY_VERSION = 'STRATEGY_MARKET_ELIGIBILITY_V1';
export const STRATEGY_MARKET_ELIGIBILITY_AUTHORITY = 'SHADOW_ONLY';

const decisionInclude = {
  strategy: { select: { id: true, key: true, name: true, enabled: true } },
  policyRevision: { select: { id: true, revision: true, activatedAt: true } },
  marketRegimeAssessment: { select: { id: true, compositionVersion: true, targetAt: true, observedAt: true } },
  gates: { orderBy: { ordinal: 'asc' as const } },
} satisfies Prisma.StrategyMarketEligibilityDecisionInclude;

type Rule = { dimension: string; algorithmVersion: string; requirement: 'REQUIRED' | 'IGNORED'; allowedStates: Array<{ state: string }> };
type Source = { dimension: string; requiredAlgorithmVersion: string; sourceAssessmentId: number | null; sourceStatus: string | null; sourceValidUntil: Date | null; sourceEffectiveState: string | null; health: MarketRegimeCompositionSourceHealth; reasonCode: string | null };

function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export function evaluateStrategyMarketEligibility(rules: Rule[], sources: Source[], evaluatedAt: Date) {
  const gates = STRATEGY_MARKET_POLICY_DIMENSIONS.map((definition, ordinal) => {
    const rule = rules.find(item => item.dimension === definition.dimension);
    const source = sources.find(item => item.dimension === definition.dimension);
    const allowedStates = rule?.allowedStates.map(item => item.state).sort() ?? [];
    if (!rule) return { ordinal: ordinal + 1, dimension: definition.dimension, algorithmVersion: definition.algorithmVersion, requirement: 'REQUIRED' as const, outcome: 'INSUFFICIENT_EVIDENCE' as const, observedState: null, sourceHealth: null, sourceAssessmentId: null, allowedStates, reasonCode: 'POLICY_RULE_MISSING' };
    if (rule.requirement === 'IGNORED') return { ordinal: ordinal + 1, dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement, outcome: 'IGNORED' as const, observedState: source?.sourceEffectiveState ?? null, sourceHealth: source?.health ?? null, sourceAssessmentId: source?.sourceAssessmentId ?? null, allowedStates, reasonCode: 'DIMENSION_IGNORED' };
    let currentHealth = source?.health ?? null;
    let reasonCode = source?.reasonCode ?? 'SOURCE_MISSING';
    if (currentHealth === 'AVAILABLE' && source?.sourceValidUntil && source.sourceValidUntil.getTime() <= evaluatedAt.getTime()) { currentHealth = 'EXPIRED'; reasonCode = 'SOURCE_EXPIRED_AT_EVALUATION'; }
    const healthy = source && source.requiredAlgorithmVersion === rule.algorithmVersion && source.sourceStatus === 'VALID' && currentHealth === 'AVAILABLE' && Boolean(source.sourceAssessmentId) && Boolean(source.sourceEffectiveState);
    if (!healthy) return { ordinal: ordinal + 1, dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement, outcome: 'INSUFFICIENT_EVIDENCE' as const, observedState: source?.sourceEffectiveState ?? null, sourceHealth: currentHealth, sourceAssessmentId: source?.sourceAssessmentId ?? null, allowedStates, reasonCode: source?.requiredAlgorithmVersion !== rule.algorithmVersion ? 'ALGORITHM_MISMATCH' : reasonCode };
    const permitted = allowedStates.includes(source.sourceEffectiveState!);
    return { ordinal: ordinal + 1, dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement, outcome: permitted ? 'PASS' as const : 'BLOCKED' as const, observedState: source.sourceEffectiveState, sourceHealth: currentHealth, sourceAssessmentId: source.sourceAssessmentId, allowedStates, reasonCode: permitted ? 'STATE_ALLOWED' : 'STATE_NOT_ALLOWED' };
  });
  const required = gates.filter(gate => gate.requirement === 'REQUIRED');
  const outcome = required.some(gate => gate.outcome === 'INSUFFICIENT_EVIDENCE') ? 'INSUFFICIENT_EVIDENCE' : required.some(gate => gate.outcome === 'BLOCKED') ? 'BLOCKED' : 'ALLOWED';
  const reasonCode = outcome === 'INSUFFICIENT_EVIDENCE' ? 'REQUIRED_EVIDENCE_INSUFFICIENT' : outcome === 'BLOCKED' ? 'REQUIRED_STATE_BLOCKED' : 'ALL_REQUIRED_DIMENSIONS_ALLOWED';
  const expirations = required.filter(gate => gate.outcome === 'PASS').map(gate => sources.find(source => source.dimension === gate.dimension)?.sourceValidUntil).filter((value): value is Date => Boolean(value));
  const validUntil = required.length && expirations.length === required.length ? new Date(Math.min(...expirations.map(value => value.getTime()))) : null;
  return { gates, outcome, reasonCode, validUntil };
}

export async function evaluateStrategyEligibility(strategyId: number, options: { evaluatedAt?: Date; contextType?: string; contextIdentity?: string; db?: typeof prisma; retry?: boolean } = {}) {
  const db = options.db ?? prisma; const evaluatedAt = options.evaluatedAt ?? new Date();
  try { return await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Strategy" WHERE id = ${strategyId} FOR SHARE`;
    const strategy = await tx.strategy.findUnique({ where: { id: strategyId }, select: { id: true, key: true, name: true, enabled: true, marketPolicy: { include: { revisions: { where: { status: 'ACTIVE' }, include: { dimensionRules: { include: { allowedStates: true } } } } } } } });
    if (!strategy) throw new HttpError(404, 'Strategy not found.');
    const revision = strategy.marketPolicy?.revisions[0] ?? null;
    const composition = await tx.marketRegimeAssessment.findFirst({ where: { observedAt: { lte: evaluatedAt } }, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], include: { sources: true } });
    const contextType = options.contextType ?? 'CURRENT';
    if (!revision) return persistDecision(tx, { strategy, revision: null, composition, evaluatedAt, contextType, contextIdentity: options.contextIdentity ?? 'CURRENT', outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NO_ACTIVE_POLICY', validUntil: null, gates: [] });
    if (!composition) return persistDecision(tx, { strategy, revision, composition: null, evaluatedAt, contextType, contextIdentity: options.contextIdentity ?? 'CURRENT', outcome: 'INSUFFICIENT_EVIDENCE', reasonCode: 'NO_COMPOSITION', validUntil: null, gates: [] });
    const result = evaluateStrategyMarketEligibility(revision.dimensionRules as Rule[], composition.sources as Source[], evaluatedAt);
    const healthIdentity = hash(result.gates.map(gate => [gate.dimension, gate.outcome, gate.sourceAssessmentId, gate.sourceHealth]));
    return persistDecision(tx, { strategy, revision, composition, evaluatedAt, contextType, contextIdentity: options.contextIdentity ?? `CURRENT:${healthIdentity}`, ...result });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
  catch (error) {
    if (!options.retry && error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) return evaluateStrategyEligibility(strategyId, { ...options, retry: true });
    throw error;
  }
}

type Tx = Prisma.TransactionClient;
async function persistDecision(tx: Tx, args: any) {
  const canonical = { strategyId: args.strategy.id, policyRevisionId: args.revision?.id ?? null, compositionId: args.composition?.id ?? null, contextType: args.contextType, contextIdentity: args.contextIdentity, evaluationVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION, outcome: args.outcome, reasonCode: args.reasonCode, gates: args.gates.map((g: any) => ({ dimension: g.dimension, algorithmVersion: g.algorithmVersion, requirement: g.requirement, outcome: g.outcome, observedState: g.observedState, sourceHealth: g.sourceHealth, sourceAssessmentId: g.sourceAssessmentId, allowedStates: g.allowedStates, reasonCode: g.reasonCode })) };
  const decisionFingerprint = hash(canonical);
  const existing = await tx.strategyMarketEligibilityDecision.findUnique({ where: { decisionFingerprint }, include: decisionInclude });
  if (existing) return presentDecision(existing, args.evaluatedAt, args.revision?.id ?? null, args.composition?.id ?? null);
  const created = await tx.strategyMarketEligibilityDecision.create({ data: { strategyId: args.strategy.id, policyRevisionId: args.revision?.id ?? null, marketRegimeAssessmentId: args.composition?.id ?? null, contextType: args.contextType, contextIdentity: args.contextIdentity, evaluationVersion: STRATEGY_MARKET_ELIGIBILITY_VERSION, outcome: args.outcome, reasonCode: args.reasonCode, evaluatedAt: args.evaluatedAt, validUntil: args.validUntil, decisionFingerprint, strategyEnabled: args.strategy.enabled, evidenceJson: canonical, gates: { create: args.gates.map((gate: any) => ({ dimension: gate.dimension, algorithmVersion: gate.algorithmVersion, requirement: gate.requirement, outcome: gate.outcome, observedState: gate.observedState, sourceHealth: gate.sourceHealth, sourceAssessmentId: gate.sourceAssessmentId, allowedStatesJson: gate.allowedStates, reasonCode: gate.reasonCode, ordinal: gate.ordinal, evidenceJson: gate })) } }, include: decisionInclude });
  return presentDecision(created, args.evaluatedAt, args.revision?.id ?? null, args.composition?.id ?? null);
}

function presentDecision<T extends { validUntil: Date | null; policyRevisionId: number | null; marketRegimeAssessmentId: number | null }>(row: T, at: Date, activePolicyRevisionId?: number | null, applicableCompositionId?: number | null) {
  const freshness = row.policyRevisionId !== activePolicyRevisionId ? 'POLICY_SUPERSEDED' : row.marketRegimeAssessmentId !== applicableCompositionId ? 'COMPOSITION_SUPERSEDED' : row.validUntil && row.validUntil.getTime() <= at.getTime() ? 'EXPIRED' : 'CURRENT';
  return { ...row, authority: STRATEGY_MARKET_ELIGIBILITY_AUTHORITY, currentFreshness: freshness, currentlyApplicable: freshness === 'CURRENT' };
}

export async function getCurrentStrategyEligibility(strategyId: number, at = new Date()) {
  const strategy = await prisma.strategy.findUnique({ where: { id: strategyId }, select: { id: true, marketPolicy: { select: { revisions: { where: { status: 'ACTIVE' }, select: { id: true } } } } } });
  if (!strategy) throw new HttpError(404, 'Strategy not found.');
  const composition = await prisma.marketRegimeAssessment.findFirst({ where: { observedAt: { lte: at } }, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], select: { id: true } });
  const row = await prisma.strategyMarketEligibilityDecision.findFirst({ where: { strategyId }, orderBy: { id: 'desc' }, include: decisionInclude });
  return { evaluatedAt: at, authority: STRATEGY_MARKET_ELIGIBILITY_AUTHORITY, assessment: row ? presentDecision(row, at, strategy.marketPolicy?.revisions[0]?.id ?? null, composition?.id ?? null) : null, freshness: row ? presentDecision(row, at, strategy.marketPolicy?.revisions[0]?.id ?? null, composition?.id ?? null).currentFreshness : 'NOT_RECORDED' };
}
export async function listStrategyEligibilityDecisions(limit: number, beforeId?: number, strategyId?: number) { return prisma.strategyMarketEligibilityDecision.findMany({ where: { ...(beforeId ? { id: { lt: beforeId } } : {}), ...(strategyId ? { strategyId } : {}) }, orderBy: { id: 'desc' }, take: limit, include: decisionInclude }); }
export async function listCurrentStrategyEligibility(at = new Date()) {
  const strategies = await prisma.strategy.findMany({ where: { marketPolicy: { revisions: { some: { status: 'ACTIVE' } } } }, select: { id: true } });
  return Promise.all(strategies.map(strategy => getCurrentStrategyEligibility(strategy.id, at)));
}
export async function getStrategyEligibilityDecision(id: number) { const row = await prisma.strategyMarketEligibilityDecision.findUnique({ where: { id }, include: decisionInclude }); if (!row) throw new HttpError(404, 'Strategy eligibility decision not found.'); return { ...row, authority: STRATEGY_MARKET_ELIGIBILITY_AUTHORITY }; }
export async function evaluateActiveStrategyPolicies(at = new Date()) { const strategies = await prisma.strategy.findMany({ where: { marketPolicy: { revisions: { some: { status: 'ACTIVE' } } } }, select: { id: true } }); let createdOrReused = 0; for (const strategy of strategies) { await evaluateStrategyEligibility(strategy.id, { evaluatedAt: at, contextType: 'SCHEDULED' }); createdOrReused += 1; } return { evaluated: strategies.length, createdOrReused }; }

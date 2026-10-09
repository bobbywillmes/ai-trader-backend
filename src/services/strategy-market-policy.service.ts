import { Prisma, type MarketRegimeDimension } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { audit } from './external-signal-config.service.js';
import {
  marketPolicyDimensionDefinition,
  STRATEGY_MARKET_POLICY_AUTHORITY,
  STRATEGY_MARKET_POLICY_DIMENSIONS,
  type StrategyMarketPolicyDimension,
} from './strategy-market-policy.definition.js';

const revisionInclude = {
  dimensionRules: { include: { allowedStates: { orderBy: { state: 'asc' as const } } }, orderBy: { id: 'asc' as const } },
} satisfies Prisma.StrategyMarketPolicyRevisionInclude;

function policyInclude() {
  return {
    strategy: { select: { id: true, key: true, name: true } },
    revisions: { include: revisionInclude, orderBy: { revision: 'desc' as const } },
  } satisfies Prisma.StrategyMarketPolicyInclude;
}

function initialRules() {
  return STRATEGY_MARKET_POLICY_DIMENSIONS.map(item => ({
    dimension: item.dimension as MarketRegimeDimension,
    algorithmVersion: item.algorithmVersion,
    requirement: 'IGNORED' as const,
  }));
}

export type MarketPolicyValidation = { valid: boolean; errors: Array<{ dimension?: string; code: string; message: string }> };

export function validateMarketPolicyRules(rules: Array<{
  dimension: string;
  algorithmVersion: string;
  requirement: string;
  allowedStates: Array<{ state: string }>;
}>): MarketPolicyValidation {
  const errors: MarketPolicyValidation['errors'] = [];
  for (const expected of STRATEGY_MARKET_POLICY_DIMENSIONS) {
    const matching = rules.filter(rule => rule.dimension === expected.dimension);
    if (matching.length !== 1) {
      errors.push({ dimension: expected.dimension, code: 'DIMENSION_RULE_REQUIRED', message: `${expected.dimension} must have exactly one rule.` });
      continue;
    }
    const rule = matching[0]!;
    if (rule.algorithmVersion !== expected.algorithmVersion) {
      errors.push({ dimension: expected.dimension, code: 'ALGORITHM_VERSION_INVALID', message: `${expected.dimension} must use ${expected.algorithmVersion}.` });
    }
    const states = [...new Set(rule.allowedStates.map(item => item.state))];
    const invalid = states.filter(state => !(expected.allowedStates as readonly string[]).includes(state));
    if (invalid.length) errors.push({ dimension: expected.dimension, code: 'STATE_INVALID', message: `${invalid.join(', ')} is not valid for ${expected.algorithmVersion}.` });
    if (rule.requirement === 'REQUIRED' && states.length === 0) {
      errors.push({ dimension: expected.dimension, code: 'ALLOWED_STATES_REQUIRED', message: `Required ${expected.dimension} must allow at least one effective state.` });
    } else if (rule.requirement === 'IGNORED' && states.length > 0) {
      errors.push({ dimension: expected.dimension, code: 'IGNORED_STATES_FORBIDDEN', message: `Ignored ${expected.dimension} cannot contain allowed states.` });
    } else if (!['REQUIRED', 'IGNORED'].includes(rule.requirement)) {
      errors.push({ dimension: expected.dimension, code: 'REQUIREMENT_INVALID', message: `${expected.dimension} must be REQUIRED or IGNORED.` });
    }
  }
  const unsupported = rules.filter(rule => !marketPolicyDimensionDefinition(rule.dimension));
  if (unsupported.length) errors.push({ code: 'UNSUPPORTED_DIMENSION', message: 'Only the five authoritative V1 dimensions are supported.' });
  return { valid: errors.length === 0, errors };
}

export async function getStrategyMarketPolicy(strategyId: number, client = prisma) {
  if (!await client.strategy.findUnique({ where: { id: strategyId }, select: { id: true } })) throw new HttpError(404, 'Strategy not found.');
  const policy = await client.strategyMarketPolicy.findUnique({ where: { strategyId }, include: policyInclude() });
  return { authority: STRATEGY_MARKET_POLICY_AUTHORITY, supportedDimensions: STRATEGY_MARKET_POLICY_DIMENSIONS, policy };
}

export async function createStrategyMarketPolicy(strategyId: number, actorUserId: number, changeNote?: string) {
  return prisma.$transaction(async db => {
    await db.$queryRaw`SELECT id FROM "Strategy" WHERE id = ${strategyId} FOR UPDATE`;
    if (!await db.strategy.findUnique({ where: { id: strategyId }, select: { id: true } })) throw new HttpError(404, 'Strategy not found.');
    if (await db.strategyMarketPolicy.findUnique({ where: { strategyId } })) throw new HttpError(409, 'Strategy already has a market policy.');
    const policy = await db.strategyMarketPolicy.create({ data: {
      strategyId,
      authority: STRATEGY_MARKET_POLICY_AUTHORITY,
      revisions: { create: { revision: 1, status: 'PREPARED', changeNote: changeNote ?? null, dimensionRules: { create: initialRules() } } },
    }, include: policyInclude() });
    await audit(db, 'strategy_market_policy_created', 'strategy_market_policy', policy.id, actorUserId, { strategyId, authority: policy.authority, initialRevision: 1 });
    await audit(db, 'strategy_market_policy_revision_prepared', 'strategy_market_policy_revision', policy.revisions[0]!.id, actorUserId, { policyId: policy.id, strategyId, revision: 1 });
    return policy;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function prepareStrategyMarketPolicyRevision(strategyId: number, actorUserId: number, changeNote?: string) {
  return prisma.$transaction(async db => {
    const policy = await db.strategyMarketPolicy.findUnique({ where: { strategyId } });
    if (!policy) throw new HttpError(404, 'Strategy market policy not found.');
    await db.$queryRaw`SELECT id FROM "StrategyMarketPolicy" WHERE id = ${policy.id} FOR UPDATE`;
    if (await db.strategyMarketPolicyRevision.findFirst({ where: { policyId: policy.id, status: 'PREPARED' } })) throw new HttpError(409, 'A PREPARED revision already exists.');
    const latest = await db.strategyMarketPolicyRevision.findFirst({ where: { policyId: policy.id }, orderBy: { revision: 'desc' }, include: revisionInclude });
    if (!latest || latest.revision >= 2147483647) throw new HttpError(409, 'Revision sequence unavailable.');
    const row = await db.strategyMarketPolicyRevision.create({ data: {
      policyId: policy.id, revision: latest.revision + 1, status: 'PREPARED', changeNote: changeNote ?? null,
      dimensionRules: { create: latest.dimensionRules.map(rule => ({
        dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement,
        allowedStates: { create: rule.allowedStates.map(item => ({ state: item.state })) },
      })) },
    }, include: revisionInclude });
    await audit(db, 'strategy_market_policy_revision_prepared', 'strategy_market_policy_revision', row.id, actorUserId, { policyId: policy.id, strategyId, revision: row.revision, basedOnRevision: latest.revision });
    return row;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function updateStrategyMarketPolicyRule(strategyId: number, revisionId: number, dimension: StrategyMarketPolicyDimension,
  input: { requirement: 'REQUIRED' | 'IGNORED'; allowedStates: string[] }, actorUserId: number) {
  const definition = marketPolicyDimensionDefinition(dimension);
  if (!definition) throw new HttpError(400, 'Unsupported market regime dimension.');
  const states = [...new Set(input.allowedStates)];
  const invalid = states.filter(state => !(definition.allowedStates as readonly string[]).includes(state));
  if (invalid.length) throw new HttpError(400, `Invalid effective state for ${definition.algorithmVersion}.`, { invalidStates: invalid });
  if (input.requirement === 'REQUIRED' && states.length === 0) throw new HttpError(400, 'Required dimensions must allow at least one effective state.');
  if (input.requirement === 'IGNORED' && states.length > 0) throw new HttpError(400, 'Ignored dimensions cannot contain allowed states.');
  return prisma.$transaction(async db => {
    const revision = await db.strategyMarketPolicyRevision.findFirst({ where: { id: revisionId, policy: { strategyId } } });
    if (!revision) throw new HttpError(404, 'Policy revision not found.');
    await db.$queryRaw`SELECT id FROM "StrategyMarketPolicyRevision" WHERE id = ${revisionId} FOR UPDATE`;
    if (revision.status !== 'PREPARED') throw new HttpError(409, 'Only PREPARED revisions are editable.');
    const rule = await db.strategyMarketPolicyDimensionRule.findUnique({ where: { revisionId_dimension: { revisionId, dimension: dimension as MarketRegimeDimension } }, include: { allowedStates: true } });
    if (!rule) throw new HttpError(409, 'Prepared revision is incomplete.');
    const before = { requirement: rule.requirement, allowedStates: rule.allowedStates.map(item => item.state).sort() };
    await db.strategyMarketPolicyAllowedState.deleteMany({ where: { ruleId: rule.id } });
    const updated = await db.strategyMarketPolicyDimensionRule.update({ where: { id: rule.id }, data: {
      requirement: input.requirement,
      allowedStates: { create: states.map(state => ({ state })) },
    }, include: { allowedStates: { orderBy: { state: 'asc' } } } });
    await audit(db, 'strategy_market_policy_rule_updated', 'strategy_market_policy_revision', revision.id, actorUserId, { strategyId, revision: revision.revision, dimension, before, after: { requirement: input.requirement, allowedStates: states.sort() } });
    return updated;
  });
}

export async function validateStrategyMarketPolicyRevision(strategyId: number, revisionId: number, client = prisma) {
  const revision = await client.strategyMarketPolicyRevision.findFirst({ where: { id: revisionId, policy: { strategyId } }, include: revisionInclude });
  if (!revision) throw new HttpError(404, 'Policy revision not found.');
  return { revisionId, revision: revision.revision, status: revision.status, ...validateMarketPolicyRules(revision.dimensionRules) };
}

export async function activateStrategyMarketPolicyRevision(strategyId: number, revisionId: number, actorUserId: number) {
  return prisma.$transaction(async db => {
    const policy = await db.strategyMarketPolicy.findUnique({ where: { strategyId } });
    if (!policy) throw new HttpError(404, 'Strategy market policy not found.');
    await db.$queryRaw`SELECT id FROM "StrategyMarketPolicy" WHERE id = ${policy.id} FOR UPDATE`;
    const selected = await db.strategyMarketPolicyRevision.findFirst({ where: { id: revisionId, policyId: policy.id }, include: revisionInclude });
    if (!selected) throw new HttpError(404, 'Policy revision not found.');
    if (selected.status !== 'PREPARED') throw new HttpError(409, 'Only a PREPARED revision can be activated.');
    const validation = validateMarketPolicyRules(selected.dimensionRules);
    if (!validation.valid) throw new HttpError(400, 'Policy revision is incomplete or invalid.', validation.errors);
    const now = new Date();
    const active = await db.strategyMarketPolicyRevision.findFirst({ where: { policyId: policy.id, status: 'ACTIVE' } });
    if (active) {
      await db.strategyMarketPolicyRevision.update({ where: { id: active.id }, data: { status: 'RETIRED', retiredAt: now } });
      await audit(db, 'strategy_market_policy_revision_retired', 'strategy_market_policy_revision', active.id, actorUserId, { policyId: policy.id, strategyId, revision: active.revision, replacedByRevision: selected.revision });
    }
    const activated = await db.strategyMarketPolicyRevision.update({ where: { id: selected.id }, data: { status: 'ACTIVE', activatedAt: now }, include: revisionInclude });
    await db.strategyMarketPolicy.update({ where: { id: policy.id }, data: { updatedAt: now } });
    await audit(db, 'strategy_market_policy_revision_activated', 'strategy_market_policy_revision', selected.id, actorUserId, { policyId: policy.id, strategyId, revision: selected.revision, authority: STRATEGY_MARKET_POLICY_AUTHORITY, retiredRevision: active?.revision ?? null });
    return activated;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

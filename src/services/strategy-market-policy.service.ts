import { createHash } from 'node:crypto';
import { Prisma, type MarketRegimeDimension } from '@prisma/client';
import { prisma } from '../db/prisma.js';
import { HttpError } from '../errors/http-error.js';
import { audit } from './external-signal-config.service.js';
import {
  marketPolicyDimensionDefinition,
  STRATEGY_MARKET_POLICY_AUTHORITY,
  STRATEGY_MARKET_POLICY_DIMENSIONS,
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
type PolicyRuleInput = { dimension: string; algorithmVersion: string; requirement: string; allowedStates: string[] };

function canonicalRules(rules: Array<{ dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> }>) {
  return STRATEGY_MARKET_POLICY_DIMENSIONS.map(expected => {
    const rule = rules.find(item => item.dimension === expected.dimension);
    return rule ? { dimension: rule.dimension, algorithmVersion: rule.algorithmVersion, requirement: rule.requirement, allowedStates: rule.allowedStates.map(item => item.state).sort() } : { dimension: expected.dimension, missing: true };
  });
}

export function strategyMarketPolicyConfigurationFingerprint(rules: Array<{ dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> }>) {
  return createHash('sha256').update(JSON.stringify(canonicalRules(rules))).digest('hex');
}

function presentRevision<T extends { dimensionRules: Array<{ dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> }> }>(revision: T) {
  return { ...revision, configurationFingerprint: strategyMarketPolicyConfigurationFingerprint(revision.dimensionRules) };
}

function presentPolicy<T extends { revisions: Array<{ dimensionRules: Array<{ dimension: string; algorithmVersion: string; requirement: string; allowedStates: Array<{ state: string }> }> }> }>(policy: T) {
  return { ...policy, revisions: policy.revisions.map(presentRevision) };
}

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
  if (!rules.some(rule => rule.requirement === 'REQUIRED')) errors.push({ code: 'REQUIRED_DIMENSION_REQUIRED', message: 'At least one market regime dimension must be REQUIRED.' });
  return { valid: errors.length === 0, errors };
}

export async function getStrategyMarketPolicy(strategyId: number, client = prisma) {
  if (!await client.strategy.findUnique({ where: { id: strategyId }, select: { id: true } })) throw new HttpError(404, 'Strategy not found.');
  const policy = await client.strategyMarketPolicy.findUnique({ where: { strategyId }, include: policyInclude() });
  return { authority: STRATEGY_MARKET_POLICY_AUTHORITY, supportedDimensions: STRATEGY_MARKET_POLICY_DIMENSIONS, policy: policy ? presentPolicy(policy) : null };
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
    return presentPolicy(policy);
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
    return presentRevision(row);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function saveStrategyMarketPolicyRevision(strategyId: number, revisionId: number,
  input: { expectedConfigurationFingerprint: string; rules: PolicyRuleInput[] }, actorUserId: number) {
  const candidate = input.rules.map(rule => ({ ...rule, allowedStates: [...new Set(rule.allowedStates)].map(state => ({ state })) }));
  const validation = validateMarketPolicyRules(candidate);
  if (!validation.valid) throw new HttpError(400, 'Policy revision is incomplete or invalid.', validation.errors);
  return prisma.$transaction(async db => {
    const policy = await db.strategyMarketPolicy.findUnique({ where: { strategyId } });
    if (!policy) throw new HttpError(404, 'Strategy market policy not found.');
    await db.$queryRaw`SELECT id FROM "StrategyMarketPolicy" WHERE id = ${policy.id} FOR UPDATE`;
    const revision = await db.strategyMarketPolicyRevision.findFirst({ where: { id: revisionId, policyId: policy.id }, include: revisionInclude });
    if (!revision) throw new HttpError(404, 'Policy revision not found.');
    if (revision.status !== 'PREPARED') throw new HttpError(409, 'Only PREPARED revisions are editable.');
    const beforeFingerprint = strategyMarketPolicyConfigurationFingerprint(revision.dimensionRules);
    if (beforeFingerprint !== input.expectedConfigurationFingerprint) throw new HttpError(409, 'Policy revision changed after it was loaded. Reload before saving.');
    for (const expected of STRATEGY_MARKET_POLICY_DIMENSIONS) {
      const rule = revision.dimensionRules.find(item => item.dimension === expected.dimension);
      const next = candidate.find(item => item.dimension === expected.dimension)!;
      if (!rule) throw new HttpError(409, 'Prepared revision is incomplete.');
      await db.strategyMarketPolicyAllowedState.deleteMany({ where: { ruleId: rule.id } });
      await db.strategyMarketPolicyDimensionRule.update({ where: { id: rule.id }, data: {
        requirement: next.requirement as 'REQUIRED' | 'IGNORED',
        allowedStates: { create: next.allowedStates.map(item => ({ state: item.state })) },
      } });
    }
    const updated = await db.strategyMarketPolicyRevision.findUniqueOrThrow({ where: { id: revisionId }, include: revisionInclude });
    const afterFingerprint = strategyMarketPolicyConfigurationFingerprint(updated.dimensionRules);
    await audit(db, 'strategy_market_policy_revision_saved', 'strategy_market_policy_revision', revision.id, actorUserId, { strategyId, revision: revision.revision, beforeFingerprint, afterFingerprint, rules: canonicalRules(updated.dimensionRules) });
    return presentRevision(updated);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function validateStrategyMarketPolicyRevision(strategyId: number, revisionId: number, client = prisma) {
  const revision = await client.strategyMarketPolicyRevision.findFirst({ where: { id: revisionId, policy: { strategyId } }, include: revisionInclude });
  if (!revision) throw new HttpError(404, 'Policy revision not found.');
  return { revisionId, revision: revision.revision, status: revision.status, configurationFingerprint: strategyMarketPolicyConfigurationFingerprint(revision.dimensionRules), ...validateMarketPolicyRules(revision.dimensionRules) };
}

export async function activateStrategyMarketPolicyRevision(strategyId: number, revisionId: number, expectedConfigurationFingerprint: string, actorUserId: number) {
  return prisma.$transaction(async db => {
    const policy = await db.strategyMarketPolicy.findUnique({ where: { strategyId } });
    if (!policy) throw new HttpError(404, 'Strategy market policy not found.');
    await db.$queryRaw`SELECT id FROM "StrategyMarketPolicy" WHERE id = ${policy.id} FOR UPDATE`;
    const selected = await db.strategyMarketPolicyRevision.findFirst({ where: { id: revisionId, policyId: policy.id }, include: revisionInclude });
    if (!selected) throw new HttpError(404, 'Policy revision not found.');
    if (selected.status !== 'PREPARED') throw new HttpError(409, 'Only a PREPARED revision can be activated.');
    const configurationFingerprint = strategyMarketPolicyConfigurationFingerprint(selected.dimensionRules);
    if (configurationFingerprint !== expectedConfigurationFingerprint) throw new HttpError(409, 'Policy revision changed after validation. Validate the current persisted revision before activation.');
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
    return presentRevision(activated);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

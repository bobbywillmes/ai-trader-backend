import { Prisma } from '@prisma/client';

// Canonical TradingView row-lock primitives (docs/architecture/tradingview-c3b2-final-dispatch-transaction.md,
// sections 6.1 and 6.5). PostgreSQL locks rows in the order a plan produces them, not in the order a
// multi-table `FOR UPDATE OF a, b, c` names them, so every path that must respect the canonical order takes
// each relation with its own single-table statement. The mode is the strongest any later trigger in the same
// transaction will request: a pre-lock is never upgraded afterwards.
const RELATIONS = {
  user: '"User"',
  rolloutState: '"ExternalSignalExecutionRolloutState"',
  dispatchState: '"ExternalSignalBrokerDispatchState"',
  source: '"ExternalSignalSource"',
  binding: '"StrategySignalBinding"',
  revision: '"StrategySignalRevision"',
  generation: '"ExternalSignalExecutionRolloutGeneration"',
  cycle: '"ExternalSignalTradeCycle"',
  accountCycle: '"ExternalSignalTradeCycleAccount"',
  account: '"TradingAccount"',
  assignment: '"TradingAccountSubscription"',
  subscription: '"Subscription"',
  security: '"Security"',
  authorization: '"ExternalSignalEntryExecutionAuthorization"',
  intent: '"OrderIntent"',
  exposureClaim: '"EntryExposureClaim"',
  signal: '"Signal"',
  route: '"SignalRoute"',
  routingRun: '"SignalRoutingRun"',
} as const;

export type LockRelation = keyof typeof RELATIONS;
export type LockMode = 'UPDATE' | 'SHARE';
export type LockStep = readonly [relation: LockRelation, id: number, mode: LockMode];

/** Locks one row of one relation. Returns whether the row exists (a missing row takes no lock). */
export async function lockRow(tx: Prisma.TransactionClient, relation: LockRelation, id: number, mode: LockMode) {
  const table = Prisma.raw(RELATIONS[relation]);
  const clause = Prisma.raw(mode === 'UPDATE' ? 'FOR UPDATE' : 'FOR SHARE');
  const rows = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM ${table} WHERE id = ${id} ${clause}`;
  return rows.length === 1;
}

/** Locks the given rows strictly in sequence, one statement each, and returns the relations that were missing. */
export async function lockRowsInOrder(tx: Prisma.TransactionClient, steps: readonly LockStep[]) {
  const missing: LockRelation[] = [];
  for (const [relation, id, mode] of steps) if (!(await lockRow(tx, relation, id, mode))) missing.push(relation);
  return missing;
}

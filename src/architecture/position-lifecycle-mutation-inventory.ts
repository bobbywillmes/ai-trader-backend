/**
 * Phase 0 inventory of direct TrackedPosition and PositionExitState mutations.
 *
 * This is an architecture manifest, not an authority implementation. Entries marked
 * CURRENTLY_UNGUARDED are known rollout debt. The companion test prevents a new
 * direct writer from appearing without an explicit architecture review.
 */
export type PositionLifecycleMutationInventoryEntry = {
  file: string;
  operations: Readonly<Record<string, number>>;
  kind: 'RUNTIME_SERVICE' | 'WORKER' | 'OPERATOR_SCRIPT' | 'ACCEPTANCE_FIXTURE';
  futureBoundary: 'REQUIRED' | 'FIXTURE_ONLY';
  phase0Status: 'CURRENTLY_UNGUARDED' | 'PARTIAL_EXISTING_GUARDS' | 'FIXTURE_ONLY';
  responsibility: string;
};

export const POSITION_LIFECYCLE_MUTATION_INVENTORY = [
  {
    file: 'src/services/position-tracking.service.ts',
    operations: { 'trackedPosition.create': 1, 'trackedPosition.update': 2, 'trackedPosition.updateMany': 1, 'positionExitState.create': 1 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'PARTIAL_EXISTING_GUARDS',
    responsibility: 'Broker-GET discovery/adoption, market-state refresh, closure, initial ownership snapshot, and late attribution.',
  },
  {
    file: 'src/services/position-exit-state.service.ts',
    operations: { 'positionExitState.create': 1, 'positionExitState.update': 4, 'positionExitState.updateMany': 1, 'positionExitState.upsert': 2 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Lazy exit-state creation, target unlock, protective-order status, attention, reset, and closure projection.',
  },
  {
    file: 'src/services/close-position.service.ts',
    operations: { 'trackedPosition.updateMany': 3 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'PARTIAL_EXISTING_GUARDS',
    responsibility: 'Claims and releases close state for automated and owner-requested market exits.',
  },
  {
    file: 'src/services/trailing-stop-exit.service.ts',
    operations: { 'positionExitState.updateMany': 1 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'PARTIAL_EXISTING_GUARDS',
    responsibility: 'Claims protective trailing-stop submission before the verified broker-write path.',
  },
  {
    file: 'src/services/lifecycle-repair.service.ts',
    operations: { 'trackedPosition.updateMany': 1, 'positionExitState.create': 1, 'positionExitState.update': 1 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'PARTIAL_EXISTING_GUARDS',
    responsibility: 'Owner-approved local attribution repair and exit-state hydration.',
  },
  {
    file: 'src/services/tracked-position-attribution-repair.service.ts',
    operations: { 'trackedPosition.updateMany': 1 },
    kind: 'OPERATOR_SCRIPT', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Legacy CLI attribution repair after reviewed precondition checks.',
  },
  {
    file: 'src/services/tracked-position-subscription-resolution.service.ts',
    operations: { 'trackedPosition.updateMany': 1 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Links verified local entry ownership and propagates position identity to lifecycle evidence.',
  },
  {
    file: 'src/services/trade-cycle-config-snapshot.service.ts',
    operations: { 'trackedPosition.update': 1 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Freezes immutable trade-cycle configuration after verified attribution.',
  },
  {
    file: 'src/services/stale-close-intent-recovery.service.ts',
    operations: { 'trackedPosition.updateMany': 1 },
    kind: 'RUNTIME_SERVICE', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Reopens a close claim after deterministic local non-submission recovery.',
  },
  {
    file: 'src/workers/order.worker.ts',
    operations: { 'trackedPosition.updateMany': 1 },
    kind: 'WORKER', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Reopens a close claim when a queued exit is durably classified as not sent.',
  },
  {
    file: 'scripts/bootstrap-default-trading-account.ts',
    operations: { 'trackedPosition.updateMany': 1 },
    kind: 'OPERATOR_SCRIPT', futureBoundary: 'REQUIRED', phase0Status: 'CURRENTLY_UNGUARDED',
    responsibility: 'Legacy bulk TradingAccount attribution bootstrap.',
  },
  {
    file: 'scripts/lifecycle-repair-acceptance/fixture.ts',
    operations: { 'trackedPosition.create': 2 },
    kind: 'ACCEPTANCE_FIXTURE', futureBoundary: 'FIXTURE_ONLY', phase0Status: 'FIXTURE_ONLY',
    responsibility: 'Disposable isolated acceptance-harness fixture construction.',
  },
] as const satisfies readonly PositionLifecycleMutationInventoryEntry[];

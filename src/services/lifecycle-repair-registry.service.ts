export type LifecycleRepairHandlerMetadata = {
  repairType: 'RESOLVE_POSITION_ATTRIBUTION';
  version: 1;
  impact: 'LOCAL_ONLY';
  targetType: 'TrackedPosition';
  executableConfidence: readonly ['DETERMINISTIC'];
  brokerReadPolicy: 'ALLOW_EXACT_ORDER_ID_READ';
  brokerWriteMethods: readonly [];
  applyEnvironments: readonly ['PAPER'];
};

const POSITION_ATTRIBUTION_HANDLER = Object.freeze({
  repairType: 'RESOLVE_POSITION_ATTRIBUTION', version: 1, impact: 'LOCAL_ONLY',
  targetType: 'TrackedPosition', executableConfidence: ['DETERMINISTIC'],
  brokerReadPolicy: 'ALLOW_EXACT_ORDER_ID_READ', brokerWriteMethods: [],
  applyEnvironments: ['PAPER'],
} as const satisfies LifecycleRepairHandlerMetadata);

const registry = new Map<string, LifecycleRepairHandlerMetadata>([
  [POSITION_ATTRIBUTION_HANDLER.repairType, POSITION_ATTRIBUTION_HANDLER],
]);

export function getLifecycleRepairHandlerMetadata(repairType: string) {
  const handler = registry.get(repairType);
  if (!handler || handler.impact !== 'LOCAL_ONLY' || handler.brokerWriteMethods.length !== 0) {
    throw new Error(`Unknown or unsafe lifecycle repair type: ${repairType}.`);
  }
  return handler;
}

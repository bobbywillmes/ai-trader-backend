import type { LifecycleRepairCase } from "./api";

export function lifecycleRepairCaseLabels(item: LifecycleRepairCase) {
  const before = item.beforeJson && typeof item.beforeJson === "object" && !Array.isArray(item.beforeJson) ? item.beforeJson as Record<string, unknown> : {};
  if (item.repairType !== "REPAIR_HISTORICAL_ENTRY_LIFECYCLE") return {
    identity: `Case ${item.id} · ${String(before.symbol ?? "Position")} #${item.targetId}`,
    description: "Resolve position attribution",
  };
  const lifecycle = item.evidenceJson.lifecycle && typeof item.evidenceJson.lifecycle === "object" ? item.evidenceJson.lifecycle as Record<string, unknown> : {};
  const order = lifecycle.brokerOrder && typeof lifecycle.brokerOrder === "object" ? lifecycle.brokerOrder as Record<string, unknown> : {};
  return {
    identity: `Case ${item.id} · ${String(order.symbol ?? before.symbol ?? "Historical")} BUY BrokerOrder #${item.targetId}`,
    description: "Historical entry lifecycle repair",
  };
}

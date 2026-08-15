import type { LifecycleRepairCase } from "./api";

export function lifecycleRepairApplyState(item: Pick<LifecycleRepairCase, "confidence" | "expired" | "superseded" | "executed" | "executable" | "tradingAccount">) {
  if (item.tradingAccount.environment === "LIVE") return { allowed: false, label: "LIVE read-only" };
  if (item.executed) return { allowed: false, label: "Repair already executed" };
  if (item.superseded) return { allowed: false, label: "Preview superseded" };
  if (item.expired) return { allowed: false, label: "Preview expired" };
  if (item.confidence !== "DETERMINISTIC" || !item.executable) return { allowed: false, label: "Automatic repair unavailable — manual review required." };
  return { allowed: true, label: "Apply deterministic PAPER repair" };
}

import type { LifecycleRepairCase } from "./api";

export function lifecycleRepairApplyState(item: Pick<LifecycleRepairCase, "confidence" | "expired" | "superseded" | "executed" | "executable" | "tradingAccount">) {
  if (item.tradingAccount.environment === "LIVE") return { allowed: false, label: "LIVE read-only" };
  if (item.executed) return { allowed: false, label: "Repair already executed" };
  if (item.superseded) return { allowed: false, label: "Preview superseded" };
  if (item.expired) return { allowed: false, label: "Preview expired" };
  if (item.confidence !== "DETERMINISTIC" || !item.executable) return { allowed: false, label: "Automatic repair unavailable — manual review required." };
  return { allowed: true, label: "Apply deterministic PAPER repair" };
}

export function lifecycleRepairCaseState(item: Pick<LifecycleRepairCase, "repairType" | "expired" | "superseded" | "executed" | "executable" | "evidenceJson" | "actions">) {
  if (item.repairType === "REPAIR_HISTORICAL_ENTRY_LIFECYCLE") {
    const actions = item.actions ?? [];
    const components = Array.isArray(item.evidenceJson?.unresolvedComponents) ? item.evidenceJson.unresolvedComponents : [];
    const terminalVerified = actions.some((action) => action.actionType === "TERMINALIZE_ORDER_LIFECYCLE" && action.status === "VERIFIED");
    const linkVerified = actions.some((action) => action.actionType === "LINK_ENTRY_LIFECYCLE_TO_POSITION" && action.status === "VERIFIED");
    const terminalResolved = !components.includes("STALE_ORDER_STATUS") || terminalVerified;
    const linkResolved = !components.some((component) => ["MISSING_POSITION_LINK", "PARTIAL_POSITION_LINK", "CONFLICTING_POSITION_LINK"].includes(String(component))) || linkVerified;
    if (terminalResolved && linkResolved && actions.some((action) => action.status === "VERIFIED")) return { label: "Verified", color: "teal" };
    if (actions.some((action) => action.status === "APPLIED")) return { label: linkResolved ? "Verification pending" : "Verification pending · link unresolved", color: "blue" };
    if (actions.some((action) => action.status === "VERIFIED")) return { label: "Partially verified · link unresolved", color: "orange" };
    if (actions.some((action) => action.status === "FAILED")) return { label: "Action failed · repair unresolved", color: "red" };
  }
  if (item.executed) return { label: "Executed", color: "teal" };
  if (item.superseded) return { label: "Superseded", color: "orange" };
  if (item.expired) return { label: "Expired", color: "orange" };
  if (item.executable) return { label: "Executable", color: "teal" };
  return { label: "Non-executable", color: "gray" };
}

import type { AttentionSeverity } from "./types";
export function operationalAttentionBadgeLabel(count: number, highestSeverity: AttentionSeverity | null) {
  return `${count} unresolved operational attention ${count === 1 ? "item" : "items"}${highestSeverity ? `; highest severity ${highestSeverity}` : ""}`;
}

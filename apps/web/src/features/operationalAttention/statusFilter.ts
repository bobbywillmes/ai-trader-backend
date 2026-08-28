export type AttentionStatusFilter = "unresolved" | "all" | "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export const ATTENTION_STATUS_OPTIONS: Array<{ value: AttentionStatusFilter; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "unresolved", label: "Unresolved" },
  { value: "OPEN", label: "Open" },
  { value: "ACKNOWLEDGED", label: "Acknowledged" },
  { value: "RESOLVED", label: "Resolved history" },
];
export function readAttentionStatusFilter(value: string | null) {
  if (value === null || value === "OPEN,ACKNOWLEDGED" || value === "unresolved") return { value: "unresolved" as const, invalid: false };
  if (["all", "OPEN", "ACKNOWLEDGED", "RESOLVED"].includes(value)) return { value: value as AttentionStatusFilter, invalid: false };
  return { value: "unresolved" as const, invalid: true };
}
export function statusApiValue(value: AttentionStatusFilter) { return value === "unresolved" ? "OPEN,ACKNOWLEDGED" : value; }
export function applyAttentionStatusFilter(params: URLSearchParams, value: AttentionStatusFilter) {
  const next = new URLSearchParams(params);
  if (value === "unresolved") next.delete("status"); else next.set("status", value);
  next.set("page", "1");
  return next;
}

import type { Assessment, Freshness } from "./types";
export function assessmentFreshness(attempt: Assessment | null, now = new Date()): Freshness {
  if (!attempt) return "NOT_PUBLISHED";
  if (attempt.status !== "VALID") return attempt.status;
  return attempt.validUntil && new Date(attempt.validUntil).getTime() < now.getTime() ? "EXPIRED" : "AVAILABLE";
}
export const formatDateTime = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
export const label = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, character => character.toUpperCase());
export function freshnessTone(value: Freshness) { return value === "AVAILABLE" ? "positive" : value === "EXPIRED" || value === "UNAVAILABLE" ? "warning" : value === "FAILED" ? "danger" : "neutral" as const; }

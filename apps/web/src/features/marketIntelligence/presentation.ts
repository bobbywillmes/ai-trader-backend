import type { Assessment, Freshness } from "./types";
import type { DimensionKey } from "./types";
export function assessmentFreshness(attempt: Assessment | null, now = new Date()): Freshness {
  if (!attempt) return "NOT_PUBLISHED";
  if (attempt.status !== "VALID") return attempt.status;
  return attempt.validUntil && new Date(attempt.validUntil).getTime() < now.getTime() ? "EXPIRED" : "AVAILABLE";
}
export const formatDateTime = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Unavailable";
export const label = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/(^|\s)\S/g, character => character.toUpperCase());
export function freshnessTone(value: Freshness) { return value === "AVAILABLE" ? "positive" : value === "EXPIRED" || value === "UNAVAILABLE" ? "warning" : value === "FAILED" ? "danger" : "neutral" as const; }
export const percent = (value: unknown, digits = 1) => { const number = Number(value); return Number.isFinite(number) ? `${(number * 100).toFixed(digits)}%` : "Unavailable"; };
export const percentagePoints = (value: unknown, digits = 2) => { const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(digits)}%` : "Unavailable"; };
export const decimal = (value: unknown, digits = 2) => { const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits) : "Unavailable"; };
export function stateExplanation(dimension: DimensionKey, state: string | null): string {
  if (!state) return "No current effective state was published.";
  const explanations: Record<DimensionKey, Record<string, string>> = {
    trend: { UP: "Broad price trend is constructive.", NEUTRAL: "Trend confirmation is mixed or incomplete.", DOWN: "Broad price trend is deteriorating." },
    volatility: { LOW: "Realized movement is subdued.", NORMAL: "Realized movement is within its normal range.", HIGH: "Realized movement is elevated.", EXTREME: "Realized movement is exceptionally high." },
    breadth: { POSITIVE: "More of the observed universe is advancing.", MIXED: "Participation across the observed universe is divided.", NEGATIVE: "More of the observed universe is declining." },
    participation: { QUIET: "Trading volume participation is below normal.", NORMAL: "Trading volume participation is near its baseline.", ACTIVE: "Trading volume participation is elevated.", INTENSE: "Trading volume participation is exceptionally strong." },
    intradayStress: { NORMAL: "No material intraday stress is detected.", ELEVATED: "Intraday pressure is elevated.", HIGH: "Intraday pressure is high.", SEVERE: "Severe intraday stress conditions are present." },
  };
  return explanations[dimension][state] ?? `Published ${label(state)} state.`;
}

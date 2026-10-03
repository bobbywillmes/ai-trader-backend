import type { DashboardReferencePrice } from "./types";

export function displayReferencePrice(reference: DashboardReferencePrice | undefined, now = Date.now()) {
  const observed = reference?.observedAt ? Date.parse(reference.observedAt) : NaN;
  const fresh = Number.isFinite(observed) && observed <= now && now - observed <= 5 * 60_000;
  const available = reference?.provider === "TIINGO_CONSOLIDATED" && reference.available &&
    reference.freshness === "FRESH" && fresh && reference.price != null &&
    Number.isFinite(reference.price) && reference.price > 0 &&
    (reference.basis === "TIINGO_TNGO_LAST" || reference.basis === "TIINGO_LQ_REF_PRICE");
  const reason = reference?.unavailableReason === "STALE_OBSERVATION" ? "stale" : reference?.unavailableReason?.toLowerCase().replaceAll("_", " ") ??
    (!fresh && reference?.observedAt ? "stale" : "unavailable");
  return { price: available ? reference.price : null, reason };
}

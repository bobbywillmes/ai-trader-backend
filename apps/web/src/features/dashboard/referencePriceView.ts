import type { DashboardReferencePrice } from "./types";

/** Dashboard display policy. Verification availability remains freshness-sensitive. */
export function displayReferencePrice(reference: DashboardReferencePrice | undefined, now = Date.now()) {
  const observedAt = reference?.observedAt ?? null;
  const observed = observedAt ? Date.parse(observedAt) : NaN;
  const fetched = reference?.fetchedAt ? Date.parse(reference.fetchedAt) : NaN;
  const validTime = Number.isFinite(observed) && Number.isFinite(fetched) && observed <= fetched && observed <= now;
  const acceptedBasis = reference?.basis === "TIINGO_TNGO_LAST" || reference?.basis === "TIINGO_LQ_REF_PRICE";
  const acceptedState = (reference?.available === true && reference.unavailableReason === null && reference.freshness === "FRESH") ||
    (reference?.available === false && reference.unavailableReason === "STALE_OBSERVATION" && reference.freshness === "STALE");
  const displayable = reference?.provider === "TIINGO_CONSOLIDATED" && acceptedBasis && validTime &&
    reference.price != null && Number.isFinite(reference.price) && reference.price > 0 &&
    reference.providerError === null && acceptedState;
  const reason = reference?.unavailableReason?.toLowerCase().replaceAll("_", " ") ?? "unavailable";

  return {
    price: displayable ? reference.price : null,
    provider: displayable ? reference.provider : null,
    basis: displayable ? reference.basis : null,
    observedAt: displayable ? observedAt : null,
    status: displayable ? reference.freshness === "STALE" ? "lastKnown" as const : "fresh" as const : "unavailable" as const,
    reason: displayable ? null : reason,
  };
}

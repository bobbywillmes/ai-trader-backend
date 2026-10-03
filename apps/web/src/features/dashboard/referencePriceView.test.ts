import { describe, expect, it } from "vitest";
import { displayReferencePrice } from "./referencePriceView";
import type { DashboardReferencePrice } from "./types";

const now = Date.parse("2026-10-02T19:00:00Z");
const price: DashboardReferencePrice = { symbol: "SPY", provider: "TIINGO_CONSOLIDATED",
  price: 650, basis: "TIINGO_TNGO_LAST", observedAt: "2026-10-02T18:59:59Z",
  fetchedAt: "2026-10-02T19:00:00Z", freshness: "FRESH", available: true,
  unavailableReason: null, providerError: null };

describe("dashboard current price presentation", () => {
  it("accepts fresh Tiingo price and keeps basis metadata available", () => {
    expect(displayReferencePrice(price, now).price).toBe(650);
    expect(price.basis).toBe("TIINGO_TNGO_LAST");
    expect(price.observedAt).toBe("2026-10-02T18:59:59Z");
  });
  it.each([
    [{ available: false, freshness: "STALE", unavailableReason: "STALE_OBSERVATION" }, "stale"],
    [{ available: false, unavailableReason: "PROVIDER_ERROR" }, "provider error"],
    [{ observedAt: null, available: false, unavailableReason: "MISSING_TIMESTAMP" }, "missing timestamp"],
    [{ observedAt: "2026-10-02T19:01:00Z", available: false, freshness: "FUTURE", unavailableReason: "FUTURE_TIMESTAMP" }, "future timestamp"],
  ] as const)("shows unavailable for rejected observation %#", (change, reason) => {
    expect(displayReferencePrice({ ...price, ...change }, now)).toEqual({ price: null, reason });
  });
  it("expires previously fresh evidence and never uses Massive or previous close", () => {
    expect(displayReferencePrice(price, now + 6 * 60_000).price).toBeNull();
    expect(displayReferencePrice(undefined, now).price).toBeNull();
  });
});

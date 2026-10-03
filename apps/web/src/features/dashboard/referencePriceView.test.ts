import { describe, expect, it } from "vitest";
import { displayReferencePrice } from "./referencePriceView";
import type { DashboardReferencePrice } from "./types";

const friday = Date.parse("2026-10-02T23:59:00Z");
const evidence: DashboardReferencePrice = {
  symbol: "SPY", provider: "TIINGO_CONSOLIDATED", price: 650,
  basis: "TIINGO_TNGO_LAST", observedAt: "2026-10-02T23:59:00Z",
  fetchedAt: "2026-10-02T23:59:01Z", freshness: "FRESH", available: true,
  unavailableReason: null, providerError: null,
};
const stale: DashboardReferencePrice = { ...evidence, fetchedAt: "2026-10-03T15:00:00Z",
  freshness: "STALE", available: false, unavailableReason: "STALE_OBSERVATION" };

describe("dashboard reference-price display policy", () => {
  it("shows fresh Tiingo evidence with provider, basis, and observation time", () => {
    expect(displayReferencePrice(evidence, friday + 1000)).toEqual({
      price: 650, provider: "TIINGO_CONSOLIDATED", basis: "TIINGO_TNGO_LAST",
      observedAt: evidence.observedAt, status: "fresh", reason: null,
    });
  });

  it.each([
    ["Friday after-hours on Saturday", Date.parse("2026-10-03T16:00:00Z")],
    ["overnight", Date.parse("2026-10-05T10:00:00Z")],
    ["holiday or weekend", Date.parse("2026-10-06T15:00:00Z")],
  ])("shows last-known %s with Tiingo provenance and as-of time", (_label, now) => {
    expect(displayReferencePrice(stale, now)).toEqual({
      price: 650, provider: "TIINGO_CONSOLIDATED", basis: "TIINGO_TNGO_LAST",
      observedAt: evidence.observedAt, status: "lastKnown", reason: null,
    });
  });

  it("does not impose a second five-minute expiration on accepted evidence", () => {
    expect(displayReferencePrice(evidence, friday + 6 * 60_000).price).toBe(650);
    expect(displayReferencePrice(stale, friday + 7 * 24 * 60 * 60_000).price).toBe(650);
  });

  it.each([
    ["missing price", { price: null, available: false, unavailableReason: "NO_PRICE" }],
    ["zero price", { price: 0 }],
    ["non-finite price", { price: Number.NaN }],
    ["missing timestamp", { observedAt: null, freshness: "UNKNOWN", available: false, unavailableReason: "MISSING_TIMESTAMP" }],
    ["invalid timestamp", { observedAt: "invalid" }],
    ["future timestamp", { observedAt: "2026-10-03T15:01:00Z", freshness: "FUTURE", available: false, unavailableReason: "FUTURE_TIMESTAMP" }],
    ["wrong provider", { provider: "MASSIVE" }],
    ["wrong basis", { basis: "PREVIOUS_CLOSE" }],
    ["provider failure", { price: null, basis: null, observedAt: null, available: false, freshness: "UNKNOWN", unavailableReason: "PROVIDER_ERROR", providerError: "REQUEST_FAILED" }],
    ["malformed response", { available: false, unavailableReason: "MALFORMED_RESPONSE" }],
  ])("renders %s unavailable", (_label, changes) => {
    expect(displayReferencePrice({ ...evidence, ...changes } as DashboardReferencePrice, Date.parse("2026-10-03T15:00:00Z")).price).toBeNull();
  });

  it("keeps symbols independent and never uses Massive or previous-close values", () => {
    const observations = [evidence, { ...evidence, symbol: "QQQ", price: null, available: false, unavailableReason: "NO_PRICE" },
      { ...evidence, symbol: "DIA", price: 450 }, { ...evidence, symbol: "IWM", price: 250 }] as DashboardReferencePrice[];
    expect(observations.map(row => displayReferencePrice(row, friday + 1000).price)).toEqual([650, null, 450, 250]);
    expect(displayReferencePrice(undefined, friday + 1000).price).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { evaluateCorrectiveRemainderEquation, summarizeAttributedFillQuantities } from "./remaining-exposure-close.service.js";

describe("corrective remainder lifecycle equation", () => {
  it("accepts the canonical 4 / 2 / 2 lifecycle", () => {
    expect(evaluateCorrectiveRemainderEquation({ trackedQuantity: "4.000", attributedExitFilledQuantity: "2", brokerHeldQuantity: "2.0", brokerAvailableQuantity: "2" })).toEqual({ eligible: true, trackedQuantity: "4", attributedExitFilledQuantity: "2", expectedRemainingQuantity: "2", brokerHeldQuantity: "2", brokerAvailableQuantity: "2" });
  });

  it.each([
    ["broker holds less", "4", "2", "1", "1"],
    ["broker holds more", "4", "2", "3", "3"],
    ["reserved", "4", "2", "2", "1"],
    ["no attributed fill", "4", "0", "4", "4"],
    ["fully attributed", "4", "4", "0", "0"],
    ["over-attributed", "4", "5", "1", "1"],
    ["malformed available", "4", "2", "2", "NaN"],
  ])("rejects %s", (_label, trackedQuantity, attributedExitFilledQuantity, brokerHeldQuantity, brokerAvailableQuantity) => {
    expect(evaluateCorrectiveRemainderEquation({ trackedQuantity, attributedExitFilledQuantity, brokerHeldQuantity, brokerAvailableQuantity }).eligible).toBe(false);
  });

  it("uses precise decimal arithmetic", () => {
    expect(evaluateCorrectiveRemainderEquation({ trackedQuantity: "0.300000000000000003", attributedExitFilledQuantity: "0.100000000000000001", brokerHeldQuantity: "0.200000000000000002", brokerAvailableQuantity: "0.200000000000000002" }).eligible).toBe(true);
  });
});

describe("corrective remainder fill identities", () => {
  const fill = (activityId: string, qty: number, rawQty: string = String(qty)) => ({
    broker: "alpaca", mode: "paper", activityId, qty,
    rawBrokerJson: { id: activityId, qty: rawQty },
  });

  it("deduplicates repeated copies of the same individual fill identity", () => {
    const result = summarizeAttributedFillQuantities([fill("fill-1", 1), fill("fill-1", 1), fill("fill-2", 0.5)]);
    expect(result.valid).toBe(true);
    expect(result.quantity?.canonical).toBe("1.5");
  });

  it("fails closed when duplicate activity identities disagree", () => {
    expect(summarizeAttributedFillQuantities([fill("fill-1", 1), fill("fill-1", 2)])).toEqual({
      valid: false, quantity: null, reason: "CONFLICTING_DUPLICATE_IDENTITY",
    });
  });

  it("uses individual qty and never cumulative quantity", () => {
    const result = summarizeAttributedFillQuantities([{
      ...fill("fill-2", 1, "1"), rawBrokerJson: { id: "fill-2", qty: "1", cum_qty: "3" },
    }]);
    expect(result.quantity?.canonical).toBe("1");
  });

  it.each(["", "NaN", "0", "-1"])("rejects malformed or nonpositive fill quantity %s", (rawQty) => {
    const result = summarizeAttributedFillQuantities([{ ...fill("fill-1", 1, rawQty), qty: null }]);
    expect(result.valid).toBe(false);
  });
});

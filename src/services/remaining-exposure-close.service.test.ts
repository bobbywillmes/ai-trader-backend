import { describe, expect, it } from "vitest";
import { evaluateCorrectiveRemainderEquation } from "./remaining-exposure-close.service.js";

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

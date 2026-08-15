import { describe, expect, it } from "vitest";
import { lifecycleRepairApplyState } from "./lifecycleRepairView";

const base = { confidence: "DETERMINISTIC" as const, expired: false, superseded: false, executed: false, executable: true, tradingAccount: { id: 1, displayName: "Bobby Paper", environment: "PAPER" as const } };
describe("lifecycle repair apply presentation", () => {
  it("allows only current deterministic PAPER cases", () => expect(lifecycleRepairApplyState(base).allowed).toBe(true));
  it.each([
    [{ ...base, confidence: "AMBIGUOUS" as const, executable: false }, "Automatic repair unavailable"],
    [{ ...base, confidence: "STRONG" as const, executable: false }, "Automatic repair unavailable"],
    [{ ...base, confidence: "INSUFFICIENT" as const, executable: false }, "Automatic repair unavailable"],
    [{ ...base, expired: true }, "Preview expired"],
    [{ ...base, superseded: true }, "Preview superseded"],
    [{ ...base, executed: true }, "already executed"],
    [{ ...base, tradingAccount: { ...base.tradingAccount, environment: "LIVE" as const } }, "LIVE read-only"],
  ])("blocks non-executable UI state", (input, label) => {
    const result = lifecycleRepairApplyState(input);
    expect(result.allowed).toBe(false); expect(result.label).toContain(label);
  });
});

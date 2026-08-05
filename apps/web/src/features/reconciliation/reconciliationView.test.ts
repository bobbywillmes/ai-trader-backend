import { describe, expect, it } from "vitest";
import { findingIdentity, reconciliationSeverityTone } from "./reconciliationView";

describe("reconciliation responsive view", () => {
  it("uses full severity semantics for status tones", () => {
    expect(reconciliationSeverityTone("critical")).toBe("danger");
    expect(reconciliationSeverityTone("warn")).toBe("warning");
    expect(reconciliationSeverityTone("info")).toBe("informational");
  });

  it("keeps duplicate-looking findings independently addressable", () => {
    const finding = { code: "POSITION_MISMATCH", severity: "warn" as const, entityType: "TrackedPosition", entityId: "123", symbol: "SPY", message: "Mismatch" };
    expect(findingIdentity(finding, 0)).not.toBe(findingIdentity(finding, 1));
  });
});

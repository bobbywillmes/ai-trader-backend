import { describe, expect, it } from "vitest";
import { reconciliationKeys } from "./hooks";

describe("reconciliation query identity", () => {
  it("isolates mutation state by route TradingAccount ID", () => {
    expect(reconciliationKeys.account(1)).toEqual(["reconciliation", "account", 1]);
    expect(reconciliationKeys.account(2)).toEqual(["reconciliation", "account", 2]);
    expect(reconciliationKeys.account(1)).not.toEqual(reconciliationKeys.account(2));
  });
});

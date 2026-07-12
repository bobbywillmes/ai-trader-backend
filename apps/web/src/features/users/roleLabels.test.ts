import { describe, expect, it } from "vitest";
import { getPlatformRoleLabel } from "./roleLabels";

describe("platform role labels", () => {
  it("uses the approved user-facing vocabulary", () => {
    expect(getPlatformRoleLabel("SYSTEM_OWNER")).toBe("System Owner");
    expect(getPlatformRoleLabel("OPERATOR")).toBe("Operator");
    expect(getPlatformRoleLabel("ACCOUNT_USER")).toBe("Account User");
  });
});

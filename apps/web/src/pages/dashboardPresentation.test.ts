import { describe, expect, it } from "vitest";
import { getDashboardDescription } from "./dashboardPresentation";

describe("dashboard presentation", () => {
  it("uses a personal description for Account Users", () => {
    expect(getDashboardDescription("ACCOUNT_USER", true, null)).toBe(
      "Overview of your Trading Accounts and trading activity",
    );
  });

  it("preserves the System Owner operational descriptions", () => {
    expect(getDashboardDescription("SYSTEM_OWNER", true, null)).toBe(
      "Operational overview across all Trading Accounts",
    );
    expect(getDashboardDescription("SYSTEM_OWNER", false, null)).toBe(
      "Operational command center",
    );
  });
});

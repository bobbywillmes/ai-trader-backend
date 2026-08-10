import { describe, expect, it } from "vitest";
import { dashboardKeys } from "./hooks";

describe("Dashboard query isolation", () => {
  it("keeps individual Trading Accounts and ALL in separate caches", () => {
    expect(dashboardKeys.account(1)).toEqual(["dashboard", "account", 1]);
    expect(dashboardKeys.account(2)).toEqual(["dashboard", "account", 2]);
    expect(dashboardKeys.account(1)).not.toEqual(dashboardKeys.account(2));
    expect(dashboardKeys.accountsOverview).toEqual(["dashboard", "scope", "all", "accounts-overview"]);
    expect(dashboardKeys.accountsOverview).not.toEqual(dashboardKeys.account(1));
  });
});

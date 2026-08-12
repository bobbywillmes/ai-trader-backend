import { describe, expect, it } from "vitest";
import { getPageScope } from "./pageScope";

describe("page scope classification", () => {
  it.each(["/dashboard", "/positions/open", "/orders/open", "/trade-history", "/entry-decisions", "/system/events", "/reports/performance"])("classifies %s as filterable", (path) => {
    expect(getPageScope(path).mode).toBe("ACCOUNT_FILTERABLE");
  });
  it("extracts account identity from account-specific routes", () => {
    expect(getPageScope("/trading-accounts/42")).toEqual({ mode: "ACCOUNT_SPECIFIC", routeTradingAccountId: 42 });
    expect(getPageScope("/portal/accounts/9/orders")).toEqual({ mode: "ACCOUNT_SPECIFIC", routeTradingAccountId: 9 });
  });
  it("classifies canonical reconciliation by its authoritative route account", () => {
    expect(getPageScope("/trading-accounts/2/reconciliation")).toEqual({ mode: "ACCOUNT_SPECIFIC", routeTradingAccountId: 2 });
    expect(getPageScope("/system/reconciliation")).toEqual({ mode: "SYSTEM", routeTradingAccountId: null });
  });
  it.each(["/trading-accounts", "/users", "/strategies/2", "/exit-profiles", "/securities/AAPL", "/subscriptions", "/momentum-scanner", "/market-diary", "/settings", "/lifecycle-exercises/4"])("classifies %s as system scope", (path) => {
    expect(getPageScope(path).mode).toBe("SYSTEM");
  });
});

import { describe, expect, it } from "vitest";
import { canAccessRoute } from "./routeAccess";
import { createScopedNavigationTarget } from "./navigationUtils";

describe("shared route authorization", () => {
  it("denies direct owner-route access to operators and account users", () => {
    expect(canAccessRoute("users", "OPERATOR", ["system.settings.read"])).toBe(false);
    expect(canAccessRoute("settings", "ACCOUNT_USER", ["system.settings.read"])).toBe(false);
    expect(canAccessRoute("reconciliation", "ACCOUNT_USER", ["system.security.read"])).toBe(false);
    expect(canAccessRoute("lifecycleRepairs", "OPERATOR", ["system.security.read"])).toBe(false);
    expect(canAccessRoute("lifecycleRepairs", "SYSTEM_OWNER", ["system.security.read"])).toBe(true);
  });
  it("requires both an allowed role and the backend-aligned permission", () => {
    expect(canAccessRoute("reports", "ACCOUNT_USER", [])).toBe(false);
    expect(canAccessRoute("reports", "ACCOUNT_USER", ["reports.read"])).toBe(true);
  });
});

describe("TradingAccount-scoped navigation", () => {
  it("carries only account scope to another route", () => {
    expect(createScopedNavigationTarget("/reports", "?account=12&page=4&status=open")).toBe("/reports?account=12");
  });
  it("preserves target-specific parameters while replacing target account scope", () => {
    expect(createScopedNavigationTarget("/reports/performance?period=30d&account=all", "?account=12&page=4"))
      .toBe("/reports/performance?period=30d&account=12");
  });
  it("keeps persistent operational scope distinct from an account-specific path", () => {
    expect(createScopedNavigationTarget("/trading-accounts/1?tab=subscriptions", "?account=2"))
      .toBe("/trading-accounts/1?tab=subscriptions&account=2");
  });
  it("leaves targets unchanged when no scope exists", () => {
    expect(createScopedNavigationTarget("/settings", "?section=risk")).toBe("/settings");
  });
});

import { describe, expect, it } from "vitest";
import type { PlatformPermission } from "../features/auth/types";
import type { AdminNavItem } from "./navigation";
import { canAccessNavItem, createScopedNavigationTarget } from "./navigationUtils";
import { IconDashboard } from "@tabler/icons-react";

const permissions = (...values: PlatformPermission[]) => new Set(values);

describe("Admin Console navigation authorization", () => {
  it("allows System Owners to access every item", () => {
    const item: AdminNavItem = { to: "/users", label: "Users", icon: IconDashboard, systemOwnerOnly: true };
    expect(canAccessNavItem(item, true, permissions())).toBe(true);
  });

  it("rejects System Owner-only items for Operators", () => {
    const item: AdminNavItem = { to: "/users", label: "Users", icon: IconDashboard, systemOwnerOnly: true };
    expect(canAccessNavItem(item, false, permissions("system.settings.read"))).toBe(false);
  });

  it("requires the declared platform permission", () => {
    const item: AdminNavItem = { to: "/reports", label: "Reports", icon: IconDashboard, requiredPermission: "reports.read" };
    expect(canAccessNavItem(item, false, permissions())).toBe(false);
    expect(canAccessNavItem(item, false, permissions("reports.read"))).toBe(true);
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
  it("leaves targets unchanged when no scope exists", () => {
    expect(createScopedNavigationTarget("/settings", "?section=risk")).toBe("/settings");
  });
});

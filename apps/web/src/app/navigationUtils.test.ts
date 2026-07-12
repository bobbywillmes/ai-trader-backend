import { describe, expect, it } from "vitest";
import type { PlatformPermission } from "../features/auth/types";
import type { AdminNavItem } from "./navigation";
import { canAccessNavItem } from "./navigationUtils";

const permissions = (...values: PlatformPermission[]) => new Set(values);

describe("Admin Console navigation authorization", () => {
  it("allows System Owners to access every item", () => {
    const item: AdminNavItem = { to: "/users", label: "Users", systemOwnerOnly: true };
    expect(canAccessNavItem(item, true, permissions())).toBe(true);
  });

  it("rejects System Owner-only items for Operators", () => {
    const item: AdminNavItem = { to: "/users", label: "Users", systemOwnerOnly: true };
    expect(canAccessNavItem(item, false, permissions("system.settings.read"))).toBe(false);
  });

  it("requires the declared platform permission", () => {
    const item: AdminNavItem = { to: "/reports", label: "Reports", requiredPermission: "reports.read" };
    expect(canAccessNavItem(item, false, permissions())).toBe(false);
    expect(canAccessNavItem(item, false, permissions("reports.read"))).toBe(true);
  });
});

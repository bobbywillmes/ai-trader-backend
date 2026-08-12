import { describe, expect, it } from "vitest";
import { adminNavGroups, isNavigationItemActive } from "./navigation";
import { filterNavigationGroups } from "./navigationUtils";
import type { PlatformPermission, PlatformRole } from "../features/auth/types";

const allPermissions: PlatformPermission[] = [
  "system.settings.read", "system.settings.write", "system.security.read", "system.security.write",
  "tradingAccount.read", "tradingAccount.write", "tradingAccount.risk.write", "subscription.read",
  "subscription.write", "strategy.read", "strategy.write", "exitProfile.read", "exitProfile.write",
  "reports.read", "systemEvents.read", "tradingLifecycleExercise.read", "tradingLifecycleExercise.write",
];

function visibleLabels(role: PlatformRole, permissions = allPermissions) {
  return filterNavigationGroups(adminNavGroups, role, permissions).flatMap((group) =>
    group.items.flatMap((item) => [item.label, ...(item.children?.map((child) => child.label) ?? [])]));
}

describe("role-aware navigation configuration", () => {
  it("keeps every owner destination and the Trading Setup hierarchy", () => {
    const groups = filterNavigationGroups(adminNavGroups, "SYSTEM_OWNER", allPermissions);
    expect(groups.map((group) => group.label)).toEqual(["Dashboard", "Trading", "Market Intelligence", "Reports", "System", "Administration"]);
    const setup = groups.flatMap((group) => group.items).find((item) => item.label === "Trading Setup")!;
    expect(setup.children?.map((child) => child.label)).toEqual(["Strategies", "Subscriptions", "Exit Profiles"]);
    expect(isNavigationItemActive(setup, "/subscriptions")).toBe(true);
    expect(isNavigationItemActive(setup.children![1], "/subscriptions")).toBe(true);
    expect(groups.find((group) => group.label === "Trading")?.items.map((item) => item.label)).toEqual(["Open Positions", "Open Orders", "Entry Decisions"]);
    expect(groups.find((group) => group.label === "System")?.items.map((item) => item.label)).toContain("Lifecycle Exercises");
    expect(groups.find((group) => group.label === "Administration")?.items.map((item) => item.label)).toContain("Trading Setup");
  });

  it("gives operators broad operations without owner-critical destinations", () => {
    const labels = visibleLabels("OPERATOR");
    expect(labels).toEqual(expect.arrayContaining(["Dashboard", "Open Positions", "Open Orders", "Entry Decisions", "Trading Setup", "Momentum Scanner", "Reports", "Trading Accounts", "System Events"]));
    expect(labels).not.toEqual(expect.arrayContaining(["Users & Access", "Settings", "Securities", "Reconciliation", "Lifecycle Exercises"]));
  });

  it("limits account users to the personal trading surface", () => {
    const groups = filterNavigationGroups(adminNavGroups, "ACCOUNT_USER", allPermissions);
    expect(visibleLabels("ACCOUNT_USER")).toEqual(["Dashboard", "Open Positions", "Open Orders", "Reports", "Trade History", "My Accounts"]);
    expect(groups.map((group) => group.label)).toEqual(["Dashboard", "Trading", "Reports", "Accounts"]);
    expect(groups.find((group) => group.label === "Accounts")?.items.map((item) => item.label)).toEqual(["My Accounts"]);
  });

  it("prefers Reconciliation over Trading Accounts for account reconciliation routes", () => {
    const items = adminNavGroups.flatMap((group) => group.items);
    const accounts = items.find((item) => item.routeId === "tradingAccounts")!;
    const reconciliation = items.find((item) => item.routeId === "reconciliation")!;
    expect(isNavigationItemActive(accounts, "/trading-accounts/42")).toBe(true);
    expect(isNavigationItemActive(accounts, "/trading-accounts/42/reconciliation")).toBe(false);
    expect(isNavigationItemActive(reconciliation, "/trading-accounts/42/reconciliation")).toBe(true);
  });
});

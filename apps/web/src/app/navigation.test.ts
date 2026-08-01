import { describe, expect, it } from "vitest";
import { adminNavGroups, createPortalNavGroups, isNavigationItemActive } from "./navigation";
import { filterNavigationGroups } from "./navigationUtils";

describe("navigation configuration", () => {
  it("provides an icon and active-route behavior for every destination", () => {
    for (const group of adminNavGroups) for (const item of group.items) {
      expect(item.icon).toBeTypeOf("object");
      expect(isNavigationItemActive(item, item.to)).toBe(true);
      expect(isNavigationItemActive(item, `${item.to}/detail`)).toBe(true);
    }
  });

  it("does not render inaccessible or empty sections", () => {
    const groups = filterNavigationGroups(adminNavGroups, "OPERATOR", ["reports.read"]);
    expect(groups.every((group) => group.items.length > 0)).toBe(true);
    expect(groups.flatMap((group) => group.items).some((item) => item.to === "/users")).toBe(false);
  });

  it("keeps account details active without hiding account sub-navigation", () => {
    const groups = createPortalNavGroups("/portal/accounts/42");
    expect(groups[0].items.map((item) => item.label)).toEqual(["Dashboard", "Accounts", "Positions", "Orders", "Trade History"]);
    expect(isNavigationItemActive(groups[0].items[1], "/portal/accounts/42")).toBe(true);
  });
});

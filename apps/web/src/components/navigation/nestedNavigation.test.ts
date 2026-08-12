import { describe, expect, it } from "vitest";
import { adminNavGroups, isNavigationItemActive } from "../../app/navigation";
import { isNestedGroupOpen } from "./nestedNavigationState";

const tradingSetup = adminNavGroups.flatMap((group) => group.items)
  .find((item) => item.label === "Trading Setup")!;

describe("nested sidebar navigation", () => {
  it.each(["/strategies", "/subscriptions", "/exit-profiles"])(
    "keeps Trading Setup expanded and identifies the active child at %s",
    (pathname) => {
      expect(isNavigationItemActive(tradingSetup, pathname)).toBe(true);
      expect(isNestedGroupOpen(isNavigationItemActive(tradingSetup, pathname), false)).toBe(true);
      expect(tradingSetup.children?.filter((child) => isNavigationItemActive(child, pathname))).toHaveLength(1);
    },
  );

  it("allows manual expansion and collapse when no child is active", () => {
    expect(isNestedGroupOpen(false, false)).toBe(false);
    expect(isNestedGroupOpen(false, true)).toBe(true);
  });

  it("does not let a manual collapse hide the active route", () => {
    expect(isNestedGroupOpen(true, false)).toBe(true);
  });
});

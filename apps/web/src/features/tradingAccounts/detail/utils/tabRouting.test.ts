import { describe, expect, it } from "vitest";
import {
  isTradingAccountDetailTab,
  resolveTradingAccountDetailTab,
  tradingAccountDetailTabs,
  updateTradingAccountDetailTabSearchParams,
} from "./tabRouting";

describe("trading account detail tab routing", () => {
  it("recognizes every visible tab value", () => {
    expect(tradingAccountDetailTabs.map((tab) => tab.value)).toEqual([
      "overview",
      "positions",
      "orders",
      "subscriptions",
      "risk-health",
      "activity",
    ]);

    for (const tab of tradingAccountDetailTabs) {
      expect(isTradingAccountDetailTab(tab.value)).toBe(true);
    }
  });

  it("falls back to Overview for missing or invalid query values", () => {
    expect(resolveTradingAccountDetailTab(null)).toBe("overview");
    expect(resolveTradingAccountDetailTab("unknown")).toBe("overview");
    expect(resolveTradingAccountDetailTab("risk-health")).toBe("risk-health");
  });

  it("updates the tab parameter without discarding other query parameters", () => {
    const current = new URLSearchParams("source=audit&tab=orders");
    const next = updateTradingAccountDetailTabSearchParams(
      current,
      "subscriptions"
    );

    expect(next.get("tab")).toBe("subscriptions");
    expect(next.get("source")).toBe("audit");
    expect(current.get("tab")).toBe("orders");
  });

  it("uses the parameter-free canonical URL for Overview", () => {
    const next = updateTradingAccountDetailTabSearchParams(
      new URLSearchParams("source=audit&tab=activity"),
      "overview"
    );

    expect(next.has("tab")).toBe(false);
    expect(next.get("source")).toBe("audit");
  });
});

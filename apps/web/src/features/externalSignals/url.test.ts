import { describe, expect, it } from "vitest";
import { changeExternalParams, clearExternalFilters, readExternalParams } from "./url";
import { adminNavGroups, isNavigationItemActive } from "../../app/navigation";
import { canAccessRoute } from "../../app/routeAccess";
import { filterNavigationGroups } from "../../app/navigationUtils";
import { getPageScope } from "../../app/pageScope";

describe("External Signals URL and access contract", () => {
  it.each(["SYSTEM_OWNER", "OPERATOR", "ACCOUNT_USER"] as const)("applies owner-only policy to %s", role => {
    expect(canAccessRoute("externalSignals", role, [])).toBe(role === "SYSTEM_OWNER");
    const visible = filterNavigationGroups(adminNavGroups, role, []).flatMap(group => group.items).some(item => item.routeId === "externalSignals");
    expect(visible).toBe(role === "SYSTEM_OWNER");
  });
  it("keeps system scope and navigation active across feature locations", () => {
    const item = adminNavGroups.flatMap(group => group.items).find(item => item.routeId === "externalSignals")!;
    for (const path of ["/system/external-signals", "/system/external-signals/signals/1"]) expect(isNavigationItemActive(item, path)).toBe(true);
    expect(getPageScope("/system/external-signals").mode).toBe("SYSTEM");
  });
  it("reads direct links and isolates API filters from account scope and detail state", () => {
    const state = readExternalParams(new URLSearchParams("section=deliveries&detail=9&page=3&pageSize=50&status=DUPLICATE&signalId=2&tradingAccountId=8&strategyId=1"));
    expect(state.detail).toBe(9); expect(state.page).toBe(3);
    expect(state.query.toString()).toBe("page=3&pageSize=50&status=DUPLICATE&signalId=2");
  });
  it("resets pagination for filters and sections, preserves page size and unowned parameters", () => {
    const initial = new URLSearchParams("section=signals&page=4&pageSize=50&symbol=QQQ&detail=1&other=keep");
    const filtered = changeExternalParams(initial, { symbol: "SPY" });
    expect(filtered.get("page")).toBe("1"); expect(filtered.get("pageSize")).toBe("50");
    const switched = changeExternalParams(initial, { section: "deliveries", signalId: "1" });
    expect(switched.has("symbol")).toBe(false); expect(switched.has("detail")).toBe(false);
    expect(switched.get("signalId")).toBe("1"); expect(switched.get("other")).toBe("keep");
    expect(clearExternalFilters(switched).has("signalId")).toBe(false);
  });
  it("bounds malformed URL input", () => {
    const state = readExternalParams(new URLSearchParams("section=signals&page=-1&pageSize=999&event=EXECUTE&signalSourceId=abc&from=bad"));
    expect(state.query.toString()).toBe("page=1&pageSize=25");
  });
});

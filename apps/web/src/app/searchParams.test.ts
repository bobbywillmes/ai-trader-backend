import { describe, expect, it } from "vitest";
import { updateOwnedSearchParams } from "./searchParams";

describe("page-owned search parameters", () => {
  it("updates owned values without removing TradingAccount scope or other parameters", () => {
    const current = new URLSearchParams("account=2&section=activity&page=4&search=old");
    const owned = new URLSearchParams("page=1&search=new");
    expect(updateOwnedSearchParams(current, ["page", "search"], owned).toString())
      .toBe("account=2&section=activity&page=1&search=new");
  });

  it("removes omitted owned defaults while retaining unrelated values", () => {
    const current = new URLSearchParams("account=all&page=3&sortBy=name");
    expect(updateOwnedSearchParams(current, ["page", "sortBy"], new URLSearchParams()).toString())
      .toBe("account=all");
  });
});

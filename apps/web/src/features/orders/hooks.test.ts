import { describe, expect, it } from "vitest";
import { orderKeys } from "./hooks";

describe("order query isolation", () => {
  it("separates ALL and each Trading Account cache", () => {
    expect(orderKeys.allOpen).toEqual(["orders", "scope", "all"]);
    expect(orderKeys.accountOpen(1)).not.toEqual(orderKeys.accountOpen(2));
    expect(orderKeys.allOpen).not.toEqual(orderKeys.accountOpen(1));
  });
});

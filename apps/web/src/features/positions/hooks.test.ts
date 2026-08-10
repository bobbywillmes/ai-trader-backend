import { describe, expect, it } from "vitest";
import { positionKeys } from "./hooks";

describe("position query isolation", () => {
  it("separates ALL and each Trading Account cache", () => {
    expect(positionKeys.allOpen).toEqual(["positions", "scope", "all"]);
    expect(positionKeys.accountOpen(1)).not.toEqual(positionKeys.accountOpen(2));
    expect(positionKeys.allOpen).not.toEqual(positionKeys.accountOpen(1));
  });
});

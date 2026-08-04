import { describe, expect, it } from "vitest";
import { suggestAllocationKey } from "./utils";

describe("suggestAllocationKey", () => {
  it("generates lowercase underscore-separated keys from allocation names", () => {
    expect(suggestAllocationKey("Core Stock Paper Bucket")).toBe(
      "core_stock_paper_bucket"
    );
  });

  it("preserves supported hyphens and normalizes repeated separators", () => {
    expect(suggestAllocationKey("  Growth-US   Stocks  ")).toBe(
      "growth-us_stocks"
    );
  });
});

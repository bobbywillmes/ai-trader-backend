import { describe, expect, it } from "vitest";
import { getOccupiedAlpacaAccount } from "./availability";
import type { TradingAccount } from "./types";

const account = { id: 9, accountHolderUserId: 2, broker: "ALPACA", environment: "PAPER", displayName: "Bobby Paper" } as TradingAccount;

describe("Trading Account environment availability", () => {
  it("identifies an occupied environment and its existing account", () => {
    expect(getOccupiedAlpacaAccount([account], 2, "PAPER")?.displayName).toBe("Bobby Paper");
  });

  it("does not treat membership visibility as holder ownership", () => {
    expect(getOccupiedAlpacaAccount([account], 3, "PAPER")).toBeUndefined();
  });

  it("allows a separate Live identity for a Paper holder", () => {
    expect(getOccupiedAlpacaAccount([account], 2, "LIVE")).toBeUndefined();
  });
});

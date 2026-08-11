import { describe, expect, it } from "vitest";
import type { TradingAccount } from "../tradingAccounts/types";
import { defaultTradingAccountScope, parseAccountScope, resolveTradingAccountScope, serializeAccountScope, withAccountScope, withUserSelectedAccountScope } from "./url";

const account = (id: number) => ({ id } as TradingAccount);

describe("TradingAccount scope URL", () => {
  it.each([
    ["account=all", { kind: "VALID", scope: { type: "ALL" } }],
    ["account=42", { kind: "VALID", scope: { type: "ACCOUNT", tradingAccountId: 42 } }],
    ["", { kind: "MISSING" }],
  ])("strictly parses %s", (search, expected) => expect(parseAccountScope(new URLSearchParams(search))).toEqual(expected));

  it.each(["account=", "account=0", "account=-1", "account=1.5", "account=abc", "account=01", "account=9007199254740992"])("rejects malformed value %s", (search) => {
    expect(parseAccountScope(new URLSearchParams(search))).toEqual({ kind: "INVALID" });
  });

  it("serializes both scope variants", () => {
    expect(serializeAccountScope({ type: "ALL" })).toBe("all");
    expect(serializeAccountScope({ type: "ACCOUNT", tradingAccountId: 7 })).toBe("7");
  });

  it("defaults a System Owner to ALL regardless of account count", () => {
    expect(defaultTradingAccountScope([account(7)], "SYSTEM_OWNER")).toEqual({ type: "ALL" });
  });

  it("defaults a non-owner with one account to that account and multiple accounts to ALL", () => {
    expect(defaultTradingAccountScope([account(7)], "OPERATOR")).toEqual({ type: "ACCOUNT", tradingAccountId: 7 });
    expect(defaultTradingAccountScope([account(7), account(8)], "OPERATOR")).toEqual({ type: "ALL" });
    expect(defaultTradingAccountScope([], "OPERATOR")).toEqual({ type: "ALL" });
  });

  it("resolves inaccessible IDs to the safe default without exposing account existence", () => {
    expect(resolveTradingAccountScope({ kind: "VALID", scope: { type: "ACCOUNT", tradingAccountId: 99 } }, [account(7)], "OPERATOR"))
      .toEqual({ scope: { type: "ACCOUNT", tradingAccountId: 7 }, shouldCanonicalize: true, shouldNotify: true });
  });

  it("preserves unrelated search parameters when changing scope", () => {
    expect(withAccountScope("?tab=activity&page=2&account=1", { type: "ACCOUNT", tradingAccountId: 8 }).toString()).toBe("tab=activity&page=2&account=8");
  });

  it.each([
    [{ type: "ACCOUNT", tradingAccountId: 8 } as const, "8"],
    [{ type: "ALL" } as const, "all"],
  ])("resets dataset pagination for a user-selected %s scope and preserves filters", (scope, accountValue) => {
    const params = withUserSelectedAccountScope(
      "?account=1&page=7&pageSize=50&symbol=QQQ&status=closed",
      scope,
    );
    expect(params.get("account")).toBe(accountValue);
    expect(params.has("page")).toBe(false);
    expect(params.get("pageSize")).toBe("50");
    expect(params.get("symbol")).toBe("QQQ");
    expect(params.get("status")).toBe("closed");
  });
});

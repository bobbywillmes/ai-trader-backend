import { describe, expect, it } from "vitest";
import { isValidNewStrategyKey, normalizeNewStrategyKey } from "./strategyKey";

describe("new binding slug preview", () => {
  it.each([
    ["  Mean   Reversion  ", "mean-reversion"],
    ["ETF\tMean\nReversion", "etf-mean-reversion"],
    [" ETF -- Mean---Reversion_v2 ", "etf-mean-reversion_v2"],
    ["already_canonical-2", "already_canonical-2"],
  ])("previews %j as %s", (input, expected) => {
    expect(normalizeNewStrategyKey(input)).toBe(expected);
    expect(isValidNewStrategyKey(expected)).toBe(true);
  });
  it.each(["", " \t\n ", "strategy/key", "strategy.key", "café", "entry@long", "x".repeat(201)])("rejects %j", key => {
    expect(isValidNewStrategyKey(normalizeNewStrategyKey(key))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { describeRegularSession, formatMarketDateTime, getTradingTransition, normalizeSeries, rangePosition } from "./dashboardView";
import type { RiskStatus } from "./types";

function session(overrides: Partial<RiskStatus["entrySession"]> = {}): RiskStatus["entrySession"] {
  return { enabled: true, status: "allowed", canEnterNow: true, marketOpen: true, evaluatedAt: "2026-08-03T15:00:00Z", sessionOpenAt: "2026-08-03T13:30:00Z", entryAllowedAt: "2026-08-03T13:45:00Z", entryCutoffAt: "2026-08-03T19:45:00Z", sessionCloseAt: "2026-08-03T20:00:00Z", nextOpenAt: "2026-08-04T13:30:00Z", nextCloseAt: null, openingBufferMinutes: 15, closingBufferMinutes: 15, failClosed: true, degraded: false, rule: null, error: null, ...overrides };
}

describe("dashboard trading readiness", () => {
  it.each([
    ["open_buffer", "Entries open", "2026-08-03T13:45:00Z"],
    ["allowed", "Entry cutoff", "2026-08-03T19:45:00Z"],
    ["close_buffer", "Market closes", "2026-08-03T20:00:00Z"],
    ["market_closed", "Next market open", "2026-08-04T13:30:00Z"],
  ] as const)("maps %s to its authoritative transition", (status, label, value) => expect(getTradingTransition(session({ status }))).toEqual({ label, value }));

  it("uses the current session close when an allowed session has no cutoff or next-close", () => expect(getTradingTransition(session({ entryCutoffAt: null, nextCloseAt: null }))).toEqual({ label: "Entry cutoff", value: "2026-08-03T20:00:00Z" }));
  it("does not call a weekday after-close state a day without a session", () => expect(describeRegularSession(session({ status: "market_closed", marketOpen: false, canEnterNow: false, sessionOpenAt: null, sessionCloseAt: null }))).toBe("Regular session is closed"));
  it("leaves a missing transition truthful", () => expect(formatMarketDateTime(null)).toBe("Unavailable"));
  it("formats timestamps in New York", () => expect(formatMarketDateTime("2026-08-03T13:30:00Z")).toContain("9:30 AM EDT"));
});

describe("dashboard market pulse calculations", () => {
  it("normalizes all supplied series to zero at their first point", () => {
    const data = normalizeSeries([{ symbol: "SPY", from: null, to: null, summary: { open: null, close: null, change: null, changePercent: null, high: null, low: null }, points: [{ time: "a", close: 100 }, { time: "b", close: 110 }] }, { symbol: "QQQ", from: null, to: null, summary: { open: null, close: null, change: null, changePercent: null, high: null, low: null }, points: [{ time: "a", close: 200 }, { time: "b", close: 180 }] }]);
    expect(data[0]).toMatchObject({ SPY: 0, QQQ: 0 });
    expect(data[1]?.SPY).toBeCloseTo(10);
    expect(data[1]?.QQQ).toBeCloseTo(-10);
  });
  it("positions values and safely rejects zero-width ranges", () => { expect(rangePosition(15, 10, 20)).toBe(50); expect(rangePosition(10, 10, 10)).toBeNull(); expect(rangePosition(null, 10, 20)).toBeNull(); });
});

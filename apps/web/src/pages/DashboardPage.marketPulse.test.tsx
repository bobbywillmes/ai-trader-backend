// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import type { DashboardMarketSymbol } from "../features/dashboard/types";
import { MarketPulse } from "./DashboardPage";

function symbol(name: DashboardMarketSymbol["symbol"], changePercent: number | null): DashboardMarketSymbol {
  return {
    symbol: name,
    referencePrice: { symbol: name, provider: "TIINGO_CONSOLIDATED", price: 100, basis: "TIINGO_TNGO_LAST",
      observedAt: "2026-09-25T23:59:00.000Z", fetchedAt: "2026-09-26T15:00:00.000Z",
      freshness: "STALE", available: false, unavailableReason: "STALE_OBSERVATION", providerError: null },
    observationPhase: "POSTMARKET",
    previousClose: { sessionDate: "2026-09-25", close: 99, source: "TIINGO_REGULAR_MINUTE", reason: null },
    splitCompatibility: { status: changePercent === null ? "SPLIT_BOUNDARY" : "SAME_SESSION", fromSession: "2026-09-25", throughSession: "2026-09-25", eventIds: [], executionDates: [], reason: changePercent === null ? "SPLIT_BOUNDARY" : null },
    regularSession: { sessionDate: "2026-09-25", state: "COMPLETE", high: 101, low: 98, close: 99,
      observedThrough: "2026-09-25T19:59:00.000Z", reason: null, source: "TIINGO_REGULAR_MINUTE" },
    change: changePercent === null ? null : changePercent,
    changePercent, changeReason: changePercent === null ? "SPLIT_BOUNDARY" : null,
    rangePosition: 33, rangeReason: null,
  };
}

describe("ETF Market Pulse snapshot", () => {
  it("renders four independent Tiingo tiles and ranks only comparable changes without requesting history", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    render(<MantineProvider><MarketPulse symbols={[symbol("SPY", 1), symbol("QQQ", null), symbol("DIA", -1), symbol("IWM", 2)]} loading={false} error={null} /></MantineProvider>);
    expect(screen.getByText("ETF Market Pulse")).toBeTruthy();
    for (const ticker of ["SPY", "QQQ", "DIA", "IWM"]) expect(screen.getAllByText(ticker).length).toBeGreaterThan(0);
    expect(screen.getByText((_, node) => node?.tagName === "P" && node.textContent === "Leader IWM")).toBeTruthy();
    expect(screen.getByText((_, node) => node?.tagName === "P" && node.textContent === "Laggard DIA")).toBeTruthy();
    expect(screen.getByText(/Split boundary.*change unavailable/)).toBeTruthy();
    expect(screen.getAllByText(/last observed/)).toHaveLength(4);
    expect(screen.getAllByText(/Regular price is/)).toHaveLength(4);
    expect(screen.queryByLabelText("Market Pulse range")).toBeNull();
    expect(screen.queryByLabelText("Massive historical sparkline")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

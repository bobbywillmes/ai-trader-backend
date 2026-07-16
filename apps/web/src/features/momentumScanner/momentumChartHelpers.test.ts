import { describe, expect, it } from "vitest";
import { decisionWindow, defaultMomentumChartLayers, filterRegularSessionBars, hasEventOutsideRegularHours, isRegularMarketTime, parseMomentumChartPreferences, priorityMarkers } from "./momentumChartHelpers";
import type { MomentumMarketChartResponse } from "./types";

const marker = (id: string, type: MomentumMarketChartResponse["markers"][number]["type"], timestamp = "2026-07-15T14:00:00Z") => ({ id, type, timestamp, price: 1, label: type, candidateId: "c" });

describe("momentum chart presentation helpers", () => {
  it("uses decision-focused layer defaults and safely parses preferences", () => {
    expect(defaultMomentumChartLayers.allPriceChecks).toBe(false);
    expect(parseMomentumChartPreferences("bad json").layers).toEqual(defaultMomentumChartLayers);
    expect(parseMomentumChartPreferences('{"layers":{"volume":false},"extendedHours":true}')).toMatchObject({ layers: { volume: false, sessionVwap: true }, extendedHours: true });
  });
  it("deduplicates first/latest checks while retaining important decisions", () => {
    const markers = [marker("a", "PRICE_CHECK"), marker("b", "PRICE_CHECK"), marker("c", "ENTRY_READY"), marker("d", "ENTRY_READY")];
    expect(priorityMarkers(markers, defaultMomentumChartLayers).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
  it("calculates and clamps a padded candidate decision window", () => {
    const bars = [{ timestamp: "2026-07-15T12:00:00Z" }, { timestamp: "2026-07-15T18:00:00Z" }] as MomentumMarketChartResponse["bars"];
    expect(decisionWindow([marker("x", "CANDIDATE_DISCOVERED", "2026-07-15T14:00:00Z")], bars, "5m")).toEqual({ from: Date.parse("2026-07-15T13:00:00Z"), to: Date.parse("2026-07-15T14:30:00Z") });
  });
  it("uses New York regular-session boundaries", () => {
    expect(isRegularMarketTime("2026-07-15T13:29:00Z")).toBe(false);
    expect(isRegularMarketTime("2026-07-15T13:30:00Z")).toBe(true);
    expect(isRegularMarketTime("2026-07-15T20:00:00Z")).toBe(false);
    expect(filterRegularSessionBars([{ timestamp: "2026-07-15T13:29:00Z" }, { timestamp: "2026-07-15T14:00:00Z" }] as MomentumMarketChartResponse["bars"])).toHaveLength(1);
    expect(hasEventOutsideRegularHours([marker("x", "CANDIDATE_DISCOVERED", "2026-07-15T12:00:00Z")])).toBe(true);
  });
});

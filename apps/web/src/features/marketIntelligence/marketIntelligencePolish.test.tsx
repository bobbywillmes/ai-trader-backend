// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DimensionSummaryCard } from "./DimensionSummaryCard";
import { AssessmentEvidence } from "./AssessmentEvidence";
import { AssessmentTimeline } from "./AssessmentTimeline";
import type { Assessment, DimensionKey } from "./types";
const mocks = vi.hoisted(() => ({ timeline: vi.fn() }));
vi.mock("./hooks", async importOriginal => ({ ...await importOriginal<typeof import("./hooks")>(), useAssessmentTimeline: mocks.timeline }));
const row = (overrides: Partial<Assessment> = {}): Assessment => ({ id: 1, dimension: "TREND", algorithmVersion: "TREND_V1", evidenceSchemaVersion: 1, targetAt: "2026-10-07T20:00:00Z", sessionDate: "2026-10-07", attempt: 1, status: "VALID", reasonCode: null, rawState: "NEUTRAL", effectiveState: "NEUTRAL", dataThroughAt: "2026-10-07T20:00:00Z", validUntil: "2026-10-08T20:00:00Z", previousAssessmentId: null, startedAt: "2026-10-08T12:00:00Z", completedAt: "2026-10-08T12:00:01Z", createdAt: "2026-10-08T12:00:01Z", evidenceJson: {}, ...overrides });
const dimensions: DimensionKey[] = ["trend", "volatility", "breadth", "participation", "intradayStress"];
const wrap = (node: ReactNode, width = 1280) => { Object.defineProperty(window, "innerWidth", { value: width, configurable: true }); return render(<MantineProvider>{node}</MantineProvider>); };
describe("market intelligence polish", () => {
  afterEach(cleanup);
  beforeEach(() => mocks.timeline.mockImplementation((enabled: boolean) => enabled ? { isLoading: false, isError: false, data: Object.fromEntries(dimensions.map(key => [key, [row({ id: dimensions.indexOf(key) + 1, dimension: key.toUpperCase(), algorithmVersion: `${key.toUpperCase()}_V1` }), row({ id: dimensions.indexOf(key) + 20, algorithmVersion: `${key.toUpperCase()}_V1`, status: key === "trend" ? "FAILED" : "UNAVAILABLE", effectiveState: null })]])) } : { isLoading: false, isError: false, data: undefined }));
  it.each([390, 768, 1440])("keeps authoritative state and failure evidence readable at %s px", width => { wrap(<DimensionSummaryCard dimension="trend" title="Trend" summary={{ dimension: "TREND", algorithmVersion: "TREND_V1", latestAttempt: row({ status: "FAILED", reasonCode: "MISSING_MARKET_DATA", effectiveState: null, validUntil: null }), latestValid: row({ id: 9, effectiveState: "UP" }) }} />, width); expect(screen.getByText("Unavailable")).toBeTruthy(); expect(screen.getByText("Missing Market Data")).toBeTruthy(); expect(screen.getByText(/No current effective state/)).toBeTruthy(); expect(screen.queryByText(/^Up$/)).toBeNull(); });
  it("loads bounded independent timelines on demand and distinguishes failed from unavailable", () => { wrap(<AssessmentTimeline />); expect(mocks.timeline).toHaveBeenCalledWith(false); fireEvent.click(screen.getByRole("button", { name: "Load timeline" })); expect(mocks.timeline).toHaveBeenLastCalledWith(true); expect(screen.getByLabelText(/Trend .*FAILED/)).toBeTruthy(); expect(screen.getByLabelText(/Volatility .*UNAVAILABLE/)).toBeTruthy(); expect(screen.getByText("TREND_V1")).toBeTruthy(); });
  it("renders missing evidence safely and retains complete raw diagnostics", () => { wrap(<AssessmentEvidence dimension="intradayStress" assessment={row({ status: "UNAVAILABLE", evidenceJson: {} })} />); expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0); expect(screen.getByText("Raw diagnostic evidence")).toBeTruthy(); });
});

// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryDecisionSummary } from "./types";

const mocks = vi.hoisted(() => ({ query: { data: { decisions: [] as EntryDecisionSummary[] }, isLoading: false, isError: false, isFetching: false, error: null as Error | null, refetch: vi.fn() } }));
vi.mock("./hooks", async () => {
  const React = await import("react");
  return {
    useEntryDecisions: () => mocks.query,
    useEntryDecisionDrawer: () => {
      const [id, setId] = React.useState<number | null>(null);
      return { openDecision: setId, closeDecision: () => setId(null), drawerProps: { opened: id !== null, decision: null, isLoading: false, isError: false, error: null } };
    },
  };
});
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
import { EntryDecisionsPage } from "./EntryDecisionsPage";

let resize: ((width: number) => void) | null = null;
class ResizeObserverMock { callback: ResizeObserverCallback; constructor(callback: ResizeObserverCallback) { this.callback = callback; } observe() { resize = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() { resize = null; } unobserve() {} }
const decisions: EntryDecisionSummary[] = [{
  id: 21, tradingAccountId: null, tradingAccount: null, decisionKey: "decision-long-key", evaluatedAt: "2026-08-03T19:20:00Z", source: "n8n_etf_lean_entry_engine", symbol: "RSP", decisionState: "dip_detected", decisionReason: "below_prev_close_but_dip_threshold_not_met", signalAction: null, signalEligible: false, signalCreated: false, signalBlocked: false, blockingReason: null, persistenceReason: "decision_state_changed", currentPrice: 215.31, dipPercent: .31, dipThresholdPercent: .3, allowOrderSignals: true, dryRun: false, eventRisk: null, marketSession: "regular", tradingEnabled: true, killSwitchEnabled: false, paperMode: true, subscriptionId: 4, subscriptionKey: "rsp-dip-subscription-with-long-routing-name", strategyId: 2, strategyKey: "dip_strategy", exitProfileId: 1, exitProfileKey: "trail", orderIntentId: null, brokerOrderRecordId: null, trackedPositionId: null, createdAt: "2026-08-03T19:20:00Z",
}, { id: 22, tradingAccountId: 7, tradingAccount: { id: 7, displayName: "Bobby Paper", broker: "ALPACA", environment: "PAPER" }, decisionKey: "second", evaluatedAt: "2026-08-03T20:00:00Z", source: "runtime", symbol: "SPY", decisionState: "eligible", decisionReason: "no_dip_yet", signalAction: "buy", signalEligible: true, signalCreated: true, signalBlocked: false, blockingReason: null, persistenceReason: "periodic_evaluation", currentPrice: null, dipPercent: null, dipThresholdPercent: null, allowOrderSignals: true, dryRun: false, eventRisk: null, marketSession: null, tradingEnabled: true, killSwitchEnabled: false, paperMode: true, subscriptionId: null, subscriptionKey: null, strategyId: null, strategyKey: null, exitProfileId: null, exitProfileKey: null, orderIntentId: 91, brokerOrderRecordId: null, trackedPositionId: null, createdAt: "2026-08-03T20:00:00Z" }];
function renderPage() { return render(<MantineProvider defaultColorScheme="dark"><EntryDecisionsPage /></MantineProvider>); }
beforeEach(() => { vi.clearAllMocks(); mocks.query.data = { decisions }; mocks.query.isLoading = false; mocks.query.isError = false; mocks.query.isFetching = false; mocks.query.error = null; vi.stubGlobal("ResizeObserver", ResizeObserverMock); window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Entry Decisions responsive page", () => {
  it("renders a concise semantic wide table with human-readable full badges", async () => {
    renderPage(); resize?.(1280); const table = await screen.findByRole("table", { name: "Stored entry decisions" });
    expect(within(table).getByText("Dip detected")).toBeTruthy(); expect(within(table).getByText("Below previous close, but dip threshold not met")).toBeTruthy(); expect(within(table).getByText("Signal emitted")).toBeTruthy(); expect(table.querySelectorAll("th")).toHaveLength(6);
  });
  it("uses compact rows and keeps raw diagnostics collapsed", async () => {
    renderPage(); resize?.(800); await screen.findByText("RSP"); expect(screen.queryByRole("table")).toBeNull(); await userEvent.setup().click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(screen.getByText("Lifecycle links")).toBeTruthy(); expect(screen.getAllByText("Not created").length).toBeGreaterThan(0); expect(screen.getByRole("button", { name: /Raw diagnostics/ }).getAttribute("aria-expanded")).toBe("false");
  });
  it("uses mobile cards, opens the correct details drawer, closes on Escape, and restores focus", async () => {
    renderPage(); resize?.(390); await screen.findByText("RSP"); const openers = screen.getAllByRole("button", { name: "View details" }); await userEvent.setup().click(openers[1]);
    expect(await screen.findByRole("dialog", { name: "Entry Decision" })).toBeTruthy(); fireEvent.keyDown(document.body, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog", { name: "Entry Decision" })).toBeNull()); await waitFor(() => expect(document.activeElement).toBe(openers[1]));
  });
  it("preserves filters, mobile filter drawer, clear all, and refresh", async () => {
    renderPage(); resize?.(390); const user = userEvent.setup(); await user.type(screen.getByLabelText("Symbol"), "spy"); expect(await screen.findByText("Symbol: SPY")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Filters (1)" })); const filterDrawer = await screen.findByRole("dialog", { name: "Entry decision filters" }); await user.click(within(filterDrawer).getByRole("button", { name: "Clear all" })); expect(screen.queryByText("Symbol: SPY")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Refresh" })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
  it("renders loading, filtered-empty, and recoverable error states", async () => {
    mocks.query.data = { decisions: [] }; mocks.query.isLoading = true; const view = renderPage(); expect(screen.getByRole("status")).toBeTruthy(); mocks.query.isLoading = false; view.rerender(<MantineProvider><EntryDecisionsPage /></MantineProvider>);
    await userEvent.setup().type(screen.getByLabelText("Symbol"), "qqq"); expect(screen.getByText("No matching entry decisions")).toBeTruthy(); await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" })); expect(screen.queryByText("Symbol: QQQ")).toBeNull();
    mocks.query.isError = true; mocks.query.error = new Error("Decision service unavailable"); view.rerender(<MantineProvider><EntryDecisionsPage /></MantineProvider>); await userEvent.setup().click(screen.getByRole("button", { name: "Retry" })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
});

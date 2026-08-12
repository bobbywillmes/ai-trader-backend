// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { EntryDecisionSummary } from "./types";

const mocks = vi.hoisted(() => ({ query: { data: { decisions: [] as EntryDecisionSummary[], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } }, isLoading: false, isError: false, isFetching: false, error: null as Error | null, refetch: vi.fn() } }));
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
vi.mock("../tradingAccountScope/useTradingAccountScope", () => ({ useTradingAccountScope: () => ({ isAll: true, selectedAccount: null }) }));
vi.mock("../tradingAccountScope/TradingAccountScopeSelector", () => ({ TradingAccountScopeSelector: () => <button>Trading Account scope</button> }));
import { EntryDecisionsPage } from "./EntryDecisionsPage";

let resize: ((width: number) => void) | null = null;
class ResizeObserverMock { callback: ResizeObserverCallback; constructor(callback: ResizeObserverCallback) { this.callback = callback; } observe() { resize = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() { resize = null; } unobserve() {} }
const decisions: EntryDecisionSummary[] = [{
  id: 21, tradingAccountId: null, tradingAccount: null, decisionKey: "decision-long-key", evaluatedAt: "2026-08-03T19:20:00Z", source: "n8n_etf_lean_entry_engine", symbol: "RSP", decisionState: "dip_detected", decisionReason: "below_prev_close_but_dip_threshold_not_met", signalAction: null, signalEligible: false, signalCreated: false, signalBlocked: false, blockingReason: null, persistenceReason: "decision_state_changed", currentPrice: 215.31, dipPercent: .31, dipThresholdPercent: .3, allowOrderSignals: true, dryRun: false, eventRisk: null, marketSession: "regular", tradingEnabled: true, killSwitchEnabled: false, paperMode: true, subscriptionId: 4, subscriptionKey: "rsp-dip-subscription-with-long-routing-name", strategyId: 2, strategyKey: "dip_strategy", exitProfileId: 1, exitProfileKey: "trail", orderIntentId: null, brokerOrderRecordId: null, trackedPositionId: null, createdAt: "2026-08-03T19:20:00Z",
}, { id: 22, tradingAccountId: 7, tradingAccount: { id: 7, displayName: "Bobby Paper", broker: "ALPACA", environment: "PAPER" }, decisionKey: "second", evaluatedAt: "2026-08-03T20:00:00Z", source: "runtime", symbol: "SPY", decisionState: "eligible", decisionReason: "no_dip_yet", signalAction: "buy", signalEligible: true, signalCreated: true, signalBlocked: false, blockingReason: null, persistenceReason: "periodic_evaluation", currentPrice: null, dipPercent: null, dipThresholdPercent: null, allowOrderSignals: true, dryRun: false, eventRisk: null, marketSession: null, tradingEnabled: true, killSwitchEnabled: false, paperMode: true, subscriptionId: null, subscriptionKey: null, strategyId: null, strategyKey: null, exitProfileId: null, exitProfileKey: null, orderIntentId: 91, brokerOrderRecordId: null, trackedPositionId: null, createdAt: "2026-08-03T20:00:00Z" }];
function page() { return <MemoryRouter initialEntries={["/entry-decisions?account=all"]}><MantineProvider defaultColorScheme="dark"><EntryDecisionsPage /></MantineProvider></MemoryRouter>; }
function renderPage() { return render(page()); }
beforeEach(() => { vi.clearAllMocks(); mocks.query.data = { decisions, pagination: { page: 1, pageSize: 25, total: decisions.length, totalPages: 1 } }; mocks.query.isLoading = false; mocks.query.isError = false; mocks.query.isFetching = false; mocks.query.error = null; vi.stubGlobal("ResizeObserver", ResizeObserverMock); window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
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
    renderPage(); resize?.(390); const user = userEvent.setup(); await user.type(screen.getByLabelText("Symbol"), "spy"); expect(screen.queryByText("Symbol: SPY")).toBeNull(); await user.click(screen.getByRole("button", { name: "Filter Results" })); expect(await screen.findByText("Symbol: SPY")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Filters (1)" })); const filterDrawer = await screen.findByRole("dialog", { name: "Entry decision filters" }); await user.click(within(filterDrawer).getByRole("button", { name: "Clear all" })); await waitFor(() => expect(screen.queryByText("Symbol: SPY")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Refresh" })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
  it("renders server pagination and offers per-page choices", async () => {
    mocks.query.data = { decisions, pagination: { page: 1, pageSize: 25, total: 120, totalPages: 5 } };
    renderPage();
    expect(screen.getByText("Showing 1–25 of 120")).toBeTruthy();
    expect(screen.getAllByLabelText("Per page").length).toBeGreaterThan(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByRole("button", { name: "2" }).getAttribute("data-active")).not.toBeNull();
  });
  it("renders loading, filtered-empty, and recoverable error states", async () => {
    mocks.query.data = { decisions: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 1 } }; mocks.query.isLoading = true; const view = renderPage(); expect(screen.getByRole("status")).toBeTruthy(); mocks.query.isLoading = false; view.rerender(page());
    await userEvent.setup().type(screen.getByLabelText("Symbol"), "qqq"); await userEvent.setup().click(screen.getByRole("button", { name: "Filter Results" })); expect(screen.getByText("No matching entry decisions")).toBeTruthy(); await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" })); expect(screen.queryByText("Symbol: QQQ")).toBeNull();
    mocks.query.isError = true; mocks.query.error = new Error("Decision service unavailable"); view.rerender(page()); await userEvent.setup().click(screen.getByRole("button", { name: "Retry" })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
});

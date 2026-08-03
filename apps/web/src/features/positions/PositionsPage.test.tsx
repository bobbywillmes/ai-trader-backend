// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedPosition } from "./types";

const mocks = vi.hoisted(() => ({
  query: { data: [] as TrackedPosition[], isLoading: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  mutateAsync: vi.fn(), openCycle: vi.fn(), closeCycle: vi.fn(), confirm: vi.fn(), notify: vi.fn(), closePending: false, closeVariables: undefined as number | undefined, lifecycleOpened: false,
}));

vi.mock("./hooks", () => ({
  useOpenPositions: () => mocks.query,
  useClosePosition: () => ({ mutateAsync: mocks.mutateAsync, isPending: mocks.closePending, variables: mocks.closeVariables }),
}));
vi.mock("../tradeHistory/hooks", () => ({ useTradeCycleDrawer: () => ({ openCycle: mocks.openCycle, closeCycle: mocks.closeCycle, drawerProps: { opened: mocks.lifecycleOpened, cycle: null, isLoading: false, isError: false, error: null } }) }));
vi.mock("../tradeHistory/TradeCycleDrawer", () => ({ TradeCycleDrawer: ({ opened }: { opened: boolean }) => opened ? <aside aria-label="Lifecycle drawer">Lifecycle drawer</aside> : null }));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("@mantine/modals", () => ({ modals: { openConfirmModal: (options: unknown) => mocks.confirm(options) } }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: (options: unknown) => mocks.notify(options) } }));

import { PositionsPage } from "./PositionsPage";

let resize: ((width: number) => void) | null = null;
class ResizeObserverMock {
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; }
  observe() { resize = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  disconnect() { resize = null; }
  unobserve() {}
}

const base: TrackedPosition = {
  id: 101, tradingAccountId: 7, tradingAccount: { id: 7, displayName: "Bobby Paper Account With A Long Name", broker: "ALPACA", environment: "PAPER" },
  broker: "alpaca", symbol: "SPY", side: "long", qty: 6, avgEntryPrice: 740.85, currentPrice: 747.5,
  marketValue: 4485, costBasis: 4445.1, unrealizedPnL: 39.93, unrealizedPnLPct: .009, status: "OPEN",
  openedAt: "2026-08-01T12:00:00.000Z", lastSyncedAt: "2026-08-03T12:00:00.000Z", closedAt: null,
  trailingUnlocked: true, trailingUnlockedAt: "2026-08-02T12:00:00.000Z", trailingUnlockedPrice: 745,
  trailingStopOrderId: "broker-trail-1", trailingStopClientOrderId: "client-trail-1", trailingStopSubmittedAt: "2026-08-02T12:00:00.000Z",
  trailingStopStatus: "new", trailingStopTrailPercent: 1.25, trailingStopHwm: 750, trailingStopStopPrice: 740.63, trailingStopLastSyncedAt: "2026-08-03T12:00:00.000Z",
  subscriptionId: 8, subscription: { key: "momentum-breakout-routing-key-that-is-deliberately-long", exitProfile: { id: 3, key: "trail", name: "Trail", exitMode: "unlock_trailing_stop", targetPct: 1 } },
  exitState: { exitMode: "unlock_trailing_stop", trailBrokerOrderId: "broker-trail-1", attentionRequired: false },
};

function renderPage() {
  return render(<MantineProvider defaultColorScheme="dark"><PositionsPage /></MantineProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = [base, { ...base, id: 102, symbol: "TSLA", unrealizedPnL: -12.5, unrealizedPnLPct: -.012, currentPrice: Number.NaN, exitState: { exitMode: "unlock_trailing_stop", attentionRequired: true, attentionCode: "trail_order_rejected", attentionMessage: "Broker rejected the protective order." }, trailingStopOrderId: null, subscription: null }];
  mocks.query.isLoading = false; mocks.query.isError = false; mocks.query.error = null; mocks.closePending = false; mocks.closeVariables = undefined; mocks.lifecycleOpened = false;
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  window.matchMedia = vi.fn().mockImplementation((query) => ({ matches: false, media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Open Positions responsive page", () => {
  it("renders the concise semantic wide table with identity, P/L, and full badges", async () => {
    renderPage(); resize?.(1280);
    const table = await screen.findByRole("table", { name: "Open tracked positions" });
    expect(within(table).getAllByText("SPY").length).toBeGreaterThan(0);
    expect(within(table).getByText("+$39.93 · +0.90%")).toBeTruthy();
    expect(within(table).getByLabelText("Trail active status")).toBeTruthy();
    expect(within(table).getByLabelText("Attention required status")).toBeTruthy();
    expect(table.querySelectorAll("th")).toHaveLength(6);
  });

  it("expands wide position details inline instead of opening a drawer", async () => {
    renderPage(); resize?.(1280);
    const table = await screen.findByRole("table", { name: "Open tracked positions" });
    const button = within(table).getAllByRole("button", { name: "Details" })[0];
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toContain("Details");
    expect(within(table).getAllByText("momentum-breakout-routing-key-that-is-deliberately-long").length).toBeGreaterThan(0);
    expect(within(table).getByRole("button", { name: /Routing & identifiers/ }).getAttribute("aria-expanded")).toBe("false");
    expect(within(table).getByText("Position actions")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "SPY position details" })).toBeNull();
  });

  it("uses compact summaries and expands the correct grouped details", async () => {
    renderPage(); resize?.(800); await screen.findByText("2 open positions · 1 requiring attention");
    expect(screen.queryByRole("table")).toBeNull();
    const details = screen.getAllByRole("button", { name: "Details" });
    expect(details[0].getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(details[0]);
    expect(details[0].getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("momentum-breakout-routing-key-that-is-deliberately-long").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Routing & identifiers/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("High-water mark")).toBeTruthy();
  });

  it("uses mobile cards, opens the correct drawer, closes on Escape, and restores focus", async () => {
    renderPage(); resize?.(390); await screen.findByText("2 open positions · 1 requiring attention");
    const openers = screen.getAllByRole("button", { name: "View details" });
    await userEvent.setup().click(openers[1]);
    const drawer = await screen.findByRole("dialog", { name: "TSLA position details" });
    expect(within(drawer).getByText("Broker rejected the protective order.")).toBeTruthy();
    expect(within(drawer).getAllByText("Not available").length).toBeGreaterThan(0);
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "TSLA position details" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openers[1]));
  });

  it("preserves lifecycle and confirmed close actions", async () => {
    renderPage(); resize?.(390); await screen.findByText("2 open positions · 1 requiring attention");
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "View lifecycle" })[0]);
    expect(mocks.openCycle).toHaveBeenCalledWith(101);
    await user.click(screen.getAllByRole("button", { name: "More actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Close SPY position", hidden: true }));
    expect(mocks.confirm).toHaveBeenCalledOnce();
    const config = mocks.confirm.mock.calls[0][0] as { onConfirm: () => Promise<void> };
    await config.onConfirm();
    expect(mocks.mutateAsync).toHaveBeenCalledWith(101);
  });

  it("keeps position details and lifecycle drawers mutually exclusive", async () => {
    mocks.lifecycleOpened = true;
    renderPage(); resize?.(390); await screen.findByText("2 open positions · 1 requiring attention");
    expect(screen.getByLabelText("Lifecycle drawer")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "View details" })[0]);
    expect(mocks.closeCycle).toHaveBeenCalledOnce();
    const drawer = await screen.findByRole("dialog", { name: "SPY position details" });
    expect(screen.queryByLabelText("Lifecycle drawer")).toBeNull();
    await user.click(within(drawer).getByRole("button", { name: "View lifecycle" }));
    expect(mocks.openCycle).toHaveBeenCalledWith(101);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "SPY position details" })).toBeNull());
    expect(screen.getByLabelText("Lifecycle drawer")).toBeTruthy();
  });

  it("disables close actions and announces the closing state during submission", async () => {
    mocks.closePending = true; mocks.closeVariables = 101;
    renderPage(); resize?.(390); await screen.findByText("2 open positions · 1 requiring attention");
    expect(screen.getByLabelText("Closing status")).toBeTruthy();
    await userEvent.setup().click(screen.getAllByRole("button", { name: "More actions" })[0]);
    expect(screen.getByRole("menuitem", { name: "Closing position", hidden: true }).hasAttribute("disabled")).toBe(true);
  });

  it("renders loading, empty, and recoverable error states", async () => {
    mocks.query.data = []; mocks.query.isLoading = true;
    const view = renderPage(); expect(screen.getByRole("status").getAttribute("aria-busy")).toBe("true");
    mocks.query.isLoading = false; view.rerender(<MantineProvider><PositionsPage /></MantineProvider>);
    expect(screen.getByText("No open positions")).toBeTruthy();
    mocks.query.isError = true; mocks.query.error = new Error("Service temporarily unavailable"); view.rerender(<MantineProvider><PositionsPage /></MantineProvider>);
    expect(screen.getByText("Service temporarily unavailable")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
});

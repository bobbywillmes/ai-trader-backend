// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenOrder, OpenOrdersAccountResult } from "./types";

const mocks = vi.hoisted(() => ({
  query: { data: { accounts: [] as OpenOrdersAccountResult[] }, isLoading: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  mutateAsync: vi.fn(), pending: false, variables: undefined as { orderId: string } | undefined, confirm: vi.fn(), notify: vi.fn(),
}));
vi.mock("./hooks", () => ({ useAllOpenOrders: () => mocks.query, useTradingAccountOpenOrders: () => mocks.query, useCancelOrder: () => ({ mutateAsync: mocks.mutateAsync, isPending: mocks.pending, variables: mocks.variables }) }));
vi.mock("../tradingAccountScope/useTradingAccountScope", () => ({ useTradingAccountScope: () => ({ isAll: true, selectedAccount: null }) }));
vi.mock("../tradingAccountScope/TradingAccountScopeSelector", () => ({ TradingAccountScopeSelector: () => <button>Trading Account scope</button> }));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("@mantine/modals", () => ({ modals: { openConfirmModal: (options: unknown) => mocks.confirm(options) } }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: (options: unknown) => mocks.notify(options) } }));
import { OrdersPage } from "./OrdersPage";

let resize: ((width: number) => void) | null = null;
class ResizeObserverMock { callback: ResizeObserverCallback; constructor(callback: ResizeObserverCallback) { this.callback = callback; } observe() { resize = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() { resize = null; } unobserve() {} }
const orders: OpenOrder[] = [
  { id: "broker-order-1", tradingAccountId: 7, tradingAccount: { id: 7, displayName: "Bobby Paper Account With A Very Long Name", broker: "ALPACA", environment: "PAPER" }, symbol: "SPY", side: "sell", orderType: "stop_limit", qty: "6", filledQty: "2", limitPrice: "744.55", stopPrice: "745.00", status: "partially_filled", submittedAt: "2026-08-03T12:00:00Z", clientOrderId: "client-order-with-a-deliberately-long-routing-identifier" },
  { id: "broker-order-2", tradingAccountId: 8, tradingAccount: null, symbol: "TSLA", side: "buy", orderType: "market", qty: "1", filledQty: "0", status: "submitted", submittedAt: "2026-08-03T12:10:00Z" },
];
function renderPage() { return render(<MantineProvider defaultColorScheme="dark"><OrdersPage /></MantineProvider>); }
beforeEach(() => { vi.clearAllMocks(); mocks.query.data = { accounts: [{ account: orders[0]!.tradingAccount!, availability: "AVAILABLE", reason: null, message: null, orders }] }; mocks.query.isLoading = false; mocks.query.isError = false; mocks.query.error = null; mocks.pending = false; mocks.variables = undefined; vi.stubGlobal("ResizeObserver", ResizeObserverMock); window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Open Orders responsive page", () => {
  it("renders a concise wide table with complete side and status labels", async () => {
    renderPage(); resize?.(1280);
    const table = await screen.findByRole("table", { name: "Open broker orders" });
    expect(within(table).getByText("Partially Filled")).toBeTruthy();
    expect(within(table).getByText(/Stop Limit · \$745\.00 stop · \$744\.55 limit/)).toBeTruthy();
    expect(within(table).getByText(/Market · Market/)).toBeTruthy();
    expect(table.querySelectorAll("th")).toHaveLength(6);
  });

  it("expands compact details for the correct order and keeps routing collapsed", async () => {
    renderPage(); resize?.(800); await screen.findByText("2 confirmed open orders");
    expect(screen.queryByRole("table")).toBeNull();
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Details" })[0]);
    expect(screen.getByText("Remaining quantity")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Routing & identifiers/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the correct mobile drawer, closes on Escape, and restores focus", async () => {
    renderPage(); resize?.(390); await screen.findByText("2 confirmed open orders");
    const openers = screen.getAllByRole("button", { name: "View details" });
    await userEvent.setup().click(openers[1]);
    expect(await screen.findByRole("dialog", { name: "TSLA order details" })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "TSLA order details" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(openers[1]));
  });

  it("requires confirmation and prevents duplicate cancellation", async () => {
    renderPage(); resize?.(390); await screen.findByText("2 confirmed open orders");
    await userEvent.setup().click(screen.getAllByRole("button", { name: "More actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel SPY order", hidden: true }));
    expect(mocks.mutateAsync).not.toHaveBeenCalled(); expect(mocks.confirm).toHaveBeenCalledOnce();
    const config = mocks.confirm.mock.calls[0][0] as { onConfirm: () => Promise<void> };
    await config.onConfirm(); expect(mocks.mutateAsync).toHaveBeenCalledWith({ tradingAccountId: 7, orderId: "broker-order-1" });
  });

  it("renders shared loading, empty, and recoverable error states", async () => {
    mocks.query.data = { accounts: [] }; mocks.query.isLoading = true; const view = renderPage(); expect(screen.getByRole("status")).toBeTruthy();
    mocks.query.isLoading = false; view.rerender(<MantineProvider><OrdersPage /></MantineProvider>); expect(screen.getByText("No open orders")).toBeTruthy();
    mocks.query.isError = true; mocks.query.error = new Error("Broker unavailable"); view.rerender(<MantineProvider><OrdersPage /></MantineProvider>);
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" })); expect(mocks.query.refetch).toHaveBeenCalledOnce();
  });
});

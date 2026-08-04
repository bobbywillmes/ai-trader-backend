// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "./types";

const mocks = vi.hoisted(() => ({
  query: { data: { accounts: [] as TradingAccount[] }, isLoading: false, isError: false, error: null as Error | null, refetch: vi.fn() },
  health: [] as Array<{ data?: { riskHealth: { status: "READY" | "READY_WITH_WARNINGS" | "BLOCKED" } }; isLoading: boolean; isError: boolean }>,
  navigate: vi.fn(), owner: true,
}));
vi.mock("./hooks", () => ({ useTradingAccounts: () => mocks.query, useTradingAccountRiskHealthSummaries: (ids: number[]) => ids.map((_, index) => mocks.health[index]) }));
vi.mock("../auth/useAuth", () => ({ useIsSystemOwner: () => mocks.owner }));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("./CreateTradingAccountModal", () => ({ CreateTradingAccountModal: ({ opened }: { opened: boolean }) => opened ? <div role="dialog">Create account</div> : null }));
import { TradingAccountsPage } from "./TradingAccountsPage";

let resize: ((width: number) => void) | null = null;
class ResizeObserverMock { callback: ResizeObserverCallback; constructor(callback: ResizeObserverCallback) { this.callback = callback; } observe() { resize = (width) => this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() { resize = null; } unobserve() {} }
const base: TradingAccount = {
  id: 1, accountHolderUserId: 2, accountHolderName: "Bobby Account Holder With A Deliberately Long Name", displayName: "Bobby Paper Account With A Deliberately Long Display Name", broker: "ALPACA", environment: "PAPER", status: "ACTIVE", tradingEnabled: false, killSwitchEnabled: true,
  estimatedTradingCapital: 100000, maxDeployableNotional: 50000, enabledAllocatedNotional: 25000, remainingDeployableNotional: 25000, baseCurrency: "USD", brokerAccountId: "broker-1", brokerAccountNumberMasked: "****1234", brokerAccountStatus: "ACTIVE", lastBrokerSyncAt: "2026-08-01T12:00:00Z", lastCash: null, lastBuyingPower: null, lastEquity: 100083.26, lastPortfolioValue: null, totalOpenPositionNotional: 1000, pausedReason: null, notes: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", credential: { exists: true, status: "ACTIVE", authType: "API_KEY", keyFingerprint: "abc", verifiedAt: "2026-01-01T00:00:00Z", lastUsedAt: null, lastFailedAt: null, revokedAt: null },
};
function renderPage() { return render(<MantineProvider defaultColorScheme="dark"><TradingAccountsPage /></MantineProvider>); }
beforeEach(() => { vi.clearAllMocks(); mocks.owner = true; mocks.query.data = { accounts: [base, { ...base, id: 2, displayName: "Bobby Live", environment: "LIVE", status: "NEEDS_CREDENTIALS", credential: { ...base.credential, exists: false, status: null } }] }; mocks.query.isLoading = false; mocks.query.isError = false; mocks.query.error = null; mocks.health = [{ data: { riskHealth: { status: "READY" } }, isLoading: false, isError: false }, { data: { riskHealth: { status: "BLOCKED" } }, isLoading: false, isError: false }]; vi.stubGlobal("ResizeObserver", ResizeObserverMock); window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Trading Accounts responsive page", () => {
  it("renders a concise semantic wide table with complete safety labels", async () => { renderPage(); resize?.(1280); const table = await screen.findByRole("table", { name: "Trading accounts" }); expect(table.querySelectorAll("th")).toHaveLength(8); expect(within(table).getByLabelText("Paper status")).toBeTruthy(); expect(within(table).getByLabelText("Live status")).toBeTruthy(); expect(within(table).getByLabelText("Needs credentials status")).toBeTruthy(); expect(within(table).getAllByLabelText("Trading disabled status")).toHaveLength(2); expect(within(table).getAllByLabelText("Kill switch enabled status")).toHaveLength(2); expect(within(table).getByLabelText("Blocked status")).toBeTruthy(); expect(within(table).getAllByText(/Cash Not available/).length).toBeGreaterThan(0); });
  it("renders compact rows with progressive details", async () => { renderPage(); resize?.(800); expect(screen.queryByRole("table")).toBeNull(); const buttons = await screen.findAllByRole("button", { name: "Details" }); await userEvent.setup().click(buttons[0]); expect(screen.getByText("Capital & synchronization")).toBeTruthy(); expect(screen.getAllByText("Bobby Account Holder With A Deliberately Long Name").length).toBeGreaterThan(0); });
  it("renders mobile cards and navigates to the correct account", async () => { renderPage(); resize?.(390); await waitFor(() => expect(screen.getByLabelText("Trading accounts").getAttribute("data-presentation")).toBe("narrow")); const buttons = screen.getAllByRole("button", { name: "View account" }); expect(screen.queryByRole("table")).toBeNull(); expect(screen.getByLabelText("Live status")).toBeTruthy(); expect(buttons[0].getAttribute("aria-haspopup")).toBeNull(); await userEvent.setup().click(buttons[1]); await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/trading-accounts/2")); });
  it("permission-gates account creation", () => { mocks.owner = false; renderPage(); expect(screen.queryByRole("button", { name: "New Trading Account" })).toBeNull(); });
  it("renders loading, empty, and recoverable error states", async () => { mocks.query.data = { accounts: [] }; mocks.query.isLoading = true; const view = renderPage(); expect(screen.getByRole("status")).toBeTruthy(); mocks.query.isLoading = false; view.rerender(<MantineProvider><TradingAccountsPage /></MantineProvider>); expect(screen.getByText("No trading accounts are available to the current user.")).toBeTruthy(); mocks.query.isError = true; mocks.query.error = new Error("Accounts unavailable"); view.rerender(<MantineProvider><TradingAccountsPage /></MantineProvider>); expect(screen.getByText("Accounts unavailable")).toBeTruthy(); await userEvent.setup().click(screen.getByRole("button", { name: "Retry" })); expect(mocks.query.refetch).toHaveBeenCalledOnce(); });
});

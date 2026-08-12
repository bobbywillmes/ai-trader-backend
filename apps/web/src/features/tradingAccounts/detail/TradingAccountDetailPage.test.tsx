// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "../types";

const account = { id: 7, displayName: "Bobby Live Account With A Long Name", accountHolderName: "Bobby W", broker: "ALPACA", environment: "LIVE", status: "NEEDS_CREDENTIALS", tradingEnabled: false, killSwitchEnabled: true, credential: { exists: false } } as TradingAccount;
const mocks = vi.hoisted(() => ({ accountUser: false, query: { data: { account: undefined as TradingAccount | undefined }, isLoading: false, isError: false, error: null as Error | null } }));
vi.mock("../hooks", () => ({ useTradingAccount: () => mocks.query }));
vi.mock("../../auth/useAuth", () => ({ useIsAccountUser: () => mocks.accountUser }));
vi.mock("../../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("./tabs/overview/OverviewTab", () => ({ OverviewTab: () => <div>Overview content</div> }));
vi.mock("./tabs/positions/PositionsTab", () => ({ PositionsTab: () => <div>Positions content</div> }));
vi.mock("./tabs/orders/OrdersTab", () => ({ OrdersTab: () => <div>Orders content</div> }));
vi.mock("./tabs/subscriptions/SubscriptionsTab", () => ({ SubscriptionsTab: () => <div>Subscriptions content</div> }));
vi.mock("./tabs/riskHealth/RiskHealthTab", () => ({ RiskHealthTab: () => <div>Risk health content</div> }));
vi.mock("./tabs/readiness/ReadinessTab", () => ({ ReadinessTab: () => <div>Readiness content</div> }));
vi.mock("./tabs/activity/ActivityTab", () => ({ ActivityTab: () => <div>Activity content</div> }));
import { TradingAccountDetailPage } from "./TradingAccountDetailPage";

function Location() { return <output aria-label="location">{useLocation().pathname}{useLocation().search}</output>; }
function renderPage(entry = "/trading-accounts/7") { mocks.query.data = { account }; return render(<MantineProvider defaultColorScheme="dark"><MemoryRouter initialEntries={[entry]}><Routes><Route path="/trading-accounts" element={<Location />} /><Route path="/trading-accounts/:id" element={<><TradingAccountDetailPage /><Location /></>} /></Routes></MemoryRouter></MantineProvider>); }
afterEach(() => { cleanup(); mocks.accountUser = false; });

describe("Trading Account detail shell", () => {
  it("renders account identity, complete safety context, desktop tabs, and the mobile selector", () => { renderPage(); expect(screen.getByRole("heading", { name: account.displayName })).toBeTruthy(); expect(screen.getByLabelText("Live status")).toBeTruthy(); expect(screen.getByLabelText("Needs credentials status")).toBeTruthy(); expect(screen.getByText(/Kill switch enabled/)).toBeTruthy(); expect(screen.getByRole("tablist", { name: "Account sections" })).toBeTruthy(); expect(screen.getByRole("combobox", { name: "Account section" })).toBeTruthy(); expect(screen.getByText("Overview content")).toBeTruthy(); });
  it("preserves the account id and updates browser search state when sections change", async () => { renderPage(); const selector = screen.getByRole("combobox", { name: "Account section" }); const user = userEvent.setup(); await user.click(selector); await user.click(screen.getByRole("option", { name: "Orders", hidden: true })); expect(screen.getByLabelText("location").textContent).toBe("/trading-accounts/7?tab=orders"); expect(screen.getByText("Orders content")).toBeTruthy(); });
  it("resolves a deep-linked active section in both navigation controls", () => { renderPage("/trading-accounts/7?tab=readiness"); expect(screen.getByRole("tab", { name: "Readiness" }).getAttribute("aria-selected")).toBe("true"); expect((screen.getByRole("combobox", { name: "Account section" }) as HTMLInputElement).value).toBe("Readiness"); expect(within(screen.getByRole("tabpanel")).getByText("Readiness content")).toBeTruthy(); });
  it("preserves operational scope through the visible back-to-directory control", async () => {
    renderPage("/trading-accounts/7?account=2&tab=activity");
    await userEvent.setup().click(screen.getByRole("link", { name: "Trading Accounts" }));
    expect(screen.getByLabelText("location").textContent).toBe("/trading-accounts?account=2");
  });
  it("limits Account Users to shared read-only account sections", () => {
    mocks.accountUser = true;
    renderPage("/trading-accounts/7?tab=configuration");
    expect(screen.getByText("Overview content")).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Overview", "Positions", "Orders"]);
    expect(screen.queryByRole("button", { name: "Reconciliation" })).toBeNull();
  });
});

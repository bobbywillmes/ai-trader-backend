// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "../tradingAccounts/types";
import { TradingAccountScopeContext } from "./context";
import { TradingAccountScopeSelector } from "./TradingAccountScopeSelector";
import type { TradingAccountScopeContextValue } from "./types";

const base = { id: 1, displayName: "Primary Paper", accountHolderName: "Alex", broker: "ALPACA", environment: "PAPER" } as TradingAccount;
function renderSelector(overrides: Partial<TradingAccountScopeContextValue> = {}, mode: "SYSTEM" | "ACCOUNT_FILTERABLE" | "ACCOUNT_SPECIFIC" = "ACCOUNT_FILTERABLE", mobile = false) {
  const value: TradingAccountScopeContextValue = {
    scope: { type: "ALL" }, selectedAccount: null, accessibleAccounts: [base, { ...base, id: 2, displayName: "Primary Live", environment: "LIVE" }],
    isAll: true, isLoading: false, isError: false, error: null, setScope: vi.fn(), isAccountAccessible: () => true, ...overrides,
  };
  render(<MantineProvider><TradingAccountScopeContext.Provider value={value}><TradingAccountScopeSelector mode={mode} expanded mobile={mobile} /></TradingAccountScopeContext.Provider></MantineProvider>);
  return value;
}
afterEach(cleanup);

describe("TradingAccountScopeSelector", () => {
  it("renders aggregate and explicit PAPER/LIVE account identity", async () => {
    renderSelector();
    await userEvent.setup().click(screen.getByRole("button", { name: /Trading Account scope: All Trading Accounts/ }));
    expect(screen.getAllByText("All Trading Accounts")).toHaveLength(2);
    expect(screen.getByText("Primary Paper")).toBeTruthy();
    expect(screen.getByText("Primary Live")).toBeTruthy();
    expect(screen.getByText("PAPER")).toBeTruthy();
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(screen.getByText("Alex")).toBeTruthy();
    expect(screen.getAllByText("ALPACA")).toHaveLength(2);
  });
  it("changes scope through the context action", async () => {
    const value = renderSelector();
    await userEvent.setup().click(screen.getByRole("button", { name: /Trading Account scope/ }));
    await userEvent.setup().click(screen.getByText("Primary Live"));
    expect(value.setScope).toHaveBeenCalledWith({ type: "ACCOUNT", tradingAccountId: 2 });
  });
  it("hides scope affordance on SYSTEM pages", () => {
    renderSelector({}, "SYSTEM");
    expect(screen.queryByText(/Trading Account/)).toBeNull();
  });
  it("hides both route and preserved scope context on account-specific pages", () => {
    renderSelector({ scope: { type: "ACCOUNT", tradingAccountId: 2 }, selectedAccount: { ...base, id: 2, displayName: "Primary Live", environment: "LIVE" }, isAll: false }, "ACCOUNT_SPECIFIC");
    expect(screen.queryByText(/Trading Account/)).toBeNull();
    expect(screen.queryByText(/Primary Paper|Primary Live/)).toBeNull();
  });
  it("opens the mobile menu below the drawer control at a viewport-safe width", async () => {
    renderSelector({}, "ACCOUNT_FILTERABLE", true);
    await userEvent.setup().click(screen.getByRole("button", { name: /Trading Account scope/ }));
    const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Choose Trading Account scope"]');
    expect(menu).toBeTruthy();
    expect(menu?.getAttribute("data-position")).toBe("bottom-start");
    expect(menu?.className).toContain("mobileDropdown");
    expect(screen.getByText("Primary Live")).toBeTruthy();
    expect(screen.getByText("LIVE")).toBeTruthy();
  });
  it.each([
    [{ isLoading: true }, "Loading Trading Accounts"],
    [{ isError: true }, "Trading Accounts unavailable"],
    [{ accessibleAccounts: [] }, "No accessible Trading Accounts"],
  ])("renders deliberate query state", (overrides, label) => {
    renderSelector(overrides, "ACCOUNT_FILTERABLE");
    expect(screen.getByLabelText(label)).toBeTruthy();
  });
});

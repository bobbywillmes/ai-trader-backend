// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "../../../types";

const mocks = vi.hoisted(() => ({ useOrders: vi.fn() }));
vi.mock("../../../../orders/hooks", () => ({ useTradingAccountOpenOrders: mocks.useOrders }));
vi.mock("../../../../orders/OrdersPage", () => ({ OrdersDataView: () => <div>Order rows</div> }));
import { OrdersTab } from "./OrdersTab";

const account = { id: 41, displayName: "Primary Live" } as TradingAccount;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TradingAccount detail orders tab", () => {
  it("queries the route account explicitly and preserves dormant operational scope", () => {
    mocks.useOrders.mockReturnValue({ data: { availability: "AVAILABLE", orders: [] }, isLoading: false, isError: false });
    render(<MantineProvider><MemoryRouter initialEntries={["/trading-accounts/41?account=7&tab=orders"]}><OrdersTab account={account} token="token" /></MemoryRouter></MantineProvider>);
    expect(mocks.useOrders).toHaveBeenCalledWith(41, "token");
    expect(screen.getByRole("link", { name: "Open operational orders" }).getAttribute("href")).toBe("/orders/open?account=7");
  });

  it("keeps unavailable broker state distinct from an empty order list", () => {
    mocks.useOrders.mockReturnValue({ data: { availability: "UNAVAILABLE", message: "Credentials are missing.", orders: null }, isLoading: false, isError: false });
    render(<MantineProvider><MemoryRouter><OrdersTab account={account} token="token" /></MemoryRouter></MantineProvider>);
    expect(screen.getByText("Broker orders unavailable")).toBeTruthy();
    expect(screen.queryByText("No open orders")).toBeNull();
  });
});

// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "../../../types";

const mocks = vi.hoisted(() => ({ usePositions: vi.fn() }));
vi.mock("../../../../positions/hooks", () => ({ useTradingAccountOpenPositions: mocks.usePositions }));
vi.mock("../../../../positions/PositionsPage", () => ({ PositionsDataView: () => <div>Position rows</div> }));
import { PositionsTab } from "./PositionsTab";

const account = { id: 41, displayName: "Primary Live" } as TradingAccount;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("TradingAccount detail positions tab", () => {
  it("queries the route account explicitly and preserves dormant operational scope", () => {
    mocks.usePositions.mockReturnValue({ data: { positions: [] }, isLoading: false, isError: false });
    render(<MantineProvider><MemoryRouter initialEntries={["/trading-accounts/41?account=7&tab=positions"]}><PositionsTab account={account} token="token" /></MemoryRouter></MantineProvider>);
    expect(mocks.usePositions).toHaveBeenCalledWith(41, "token");
    expect(screen.getByRole("link", { name: "Open operational positions" }).getAttribute("href")).toBe("/positions/open?account=7");
  });
});

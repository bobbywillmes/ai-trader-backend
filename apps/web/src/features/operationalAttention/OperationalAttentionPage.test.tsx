// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ searches: [] as string[] }));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("../tradingAccountScope/TradingAccountScopeSelector", () => ({ TradingAccountScopeSelector: () => <div>Account scope</div> }));
vi.mock("./hooks", () => ({
  useAttentionList: (_token: string, search: string) => { mocks.searches.push(search); return { data: { items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }, isLoading: false, isError: false, error: null }; },
  useAttentionDetail: () => ({ data: undefined, isLoading: false, isError: false }),
  useAcknowledgeAttention: () => ({ mutate: vi.fn(), isPending: false }),
  useManualResolveAttention: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { OperationalAttentionPage } from "./OperationalAttentionPage";
function Location() { const location = useLocation(); return <output aria-label="location">{location.search}</output>; }
function renderPage(entry: string) { return render(<MantineProvider><MemoryRouter initialEntries={[entry]}><Routes><Route path="/operational-attention" element={<><OperationalAttentionPage/><Location/></>} /></Routes></MemoryRouter></MantineProvider>); }
beforeEach(() => { mocks.searches.length = 0; }); afterEach(cleanup);

describe("Operational Attention page status filtering", () => {
  it("defaults to unresolved and exposes All statuses", async () => {
    renderPage("/operational-attention?account=all");
    expect((screen.getByRole("combobox", { name: "Status" }) as HTMLInputElement).value).toBe("Unresolved");
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Status" }));
    expect(screen.getByRole("option", { name: "All statuses", hidden: true })).toBeTruthy();
    expect(mocks.searches.at(-1)).toContain("status=OPEN,ACKNOWLEDGED");
  });
  it("restores all statuses and makes one all-status request", () => { renderPage("/operational-attention?account=2&status=all&severity=ERROR&page=3"); expect((screen.getByRole("combobox", { name: "Status" }) as HTMLInputElement).value).toBe("All statuses"); expect(mocks.searches.at(-1)).toBe("?account=2&status=all&severity=ERROR&page=3&pageSize=20"); });
  it("changes status with canonical URL, resets page and preserves account and severity", async () => {
    renderPage("/operational-attention?account=2&severity=ERROR&page=4"); const user = userEvent.setup(); await user.click(screen.getByRole("combobox", { name: "Status" })); await user.click(screen.getByRole("option", { name: "All statuses", hidden: true }));
    expect(screen.getByLabelText("location").textContent).toContain("account=2"); expect(screen.getByLabelText("location").textContent).toContain("severity=ERROR"); expect(screen.getByLabelText("location").textContent).toContain("page=1"); expect(screen.getByLabelText("location").textContent).toContain("status=all");
  });
  it("normalizes invalid status with replace semantics to the default view", async () => { renderPage("/operational-attention?account=2&status=unread&severity=WARNING&page=5"); await vi.waitFor(() => expect(screen.getByLabelText("location").textContent).toBe("?account=2&severity=WARNING&page=1")); });
  it("uses neutral page wording for unresolved and historical filters", () => { renderPage("/operational-attention?status=all"); expect(screen.getByText("Account-scoped operational conditions and their history.")).toBeTruthy(); });
});

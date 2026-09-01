// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalAttention } from "./types";

const mocks = vi.hoisted(() => ({
  searches: [] as string[],
  detail: undefined as OperationalAttention | undefined,
  detailError: null as Error | null,
}));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("../tradingAccountScope/TradingAccountScopeSelector", () => ({
  TradingAccountScopeSelector: () => <div>Account scope</div>,
}));
vi.mock("./hooks", () => ({
  useAttentionList: (_token: string, search: string) => {
    mocks.searches.push(search);
    return {
      data: {
        items: [],
        pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
      },
      isLoading: false,
      isError: false,
      error: null,
    };
  },
  useAttentionDetail: () => ({
    data: mocks.detail,
    isLoading: false,
    isError: Boolean(mocks.detailError),
    error: mocks.detailError,
  }),
  useAcknowledgeAttention: () => ({ mutate: vi.fn(), isPending: false }),
  useManualResolveAttention: () => ({ mutate: vi.fn(), isPending: false }),
  useRemainingExposureClosePreview: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
  useExecuteRemainingExposureClose: () => ({
    mutate: vi.fn(),
    isPending: false,
    error: null,
  }),
}));
import { OperationalAttentionPage } from "./OperationalAttentionPage";
function Location() {
  const location = useLocation();
  return <output aria-label="location">{location.search}</output>;
}
function renderPage(entry: string) {
  return render(
    <MantineProvider>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/operational-attention"
            element={
              <>
                <OperationalAttentionPage />
                <Location />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </MantineProvider>,
  );
}
beforeEach(() => {
  mocks.searches.length = 0;
  mocks.detail = undefined;
  mocks.detailError = null;
});
afterEach(cleanup);

describe("Operational Attention page status filtering", () => {
  it("defaults to unresolved and exposes All statuses", async () => {
    renderPage("/operational-attention?account=all");
    expect(
      (screen.getByRole("combobox", { name: "Status" }) as HTMLInputElement)
        .value,
    ).toBe("Unresolved");
    await userEvent
      .setup()
      .click(screen.getByRole("combobox", { name: "Status" }));
    expect(
      screen.getByRole("option", { name: "All statuses", hidden: true }),
    ).toBeTruthy();
    expect(mocks.searches.at(-1)).toContain("status=OPEN,ACKNOWLEDGED");
  });
  it("restores all statuses and makes one all-status request", () => {
    renderPage(
      "/operational-attention?account=2&status=all&severity=ERROR&page=3",
    );
    expect(
      (screen.getByRole("combobox", { name: "Status" }) as HTMLInputElement)
        .value,
    ).toBe("All statuses");
    expect(mocks.searches.at(-1)).toBe(
      "?account=2&status=all&severity=ERROR&page=3&pageSize=20",
    );
  });
  it("changes status with canonical URL, resets page and preserves account and severity", async () => {
    renderPage("/operational-attention?account=2&severity=ERROR&page=4");
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(
      screen.getByRole("option", { name: "All statuses", hidden: true }),
    );
    expect(screen.getByLabelText("location").textContent).toContain(
      "account=2",
    );
    expect(screen.getByLabelText("location").textContent).toContain(
      "severity=ERROR",
    );
    expect(screen.getByLabelText("location").textContent).toContain("page=1");
    expect(screen.getByLabelText("location").textContent).toContain(
      "status=all",
    );
  });
  it("normalizes invalid status with replace semantics to the default view", async () => {
    renderPage(
      "/operational-attention?account=2&status=unread&severity=WARNING&page=5",
    );
    await vi.waitFor(() =>
      expect(screen.getByLabelText("location").textContent).toBe(
        "?account=2&severity=WARNING&page=1",
      ),
    );
  });
  it("uses neutral page wording for unresolved and historical filters", () => {
    renderPage("/operational-attention?status=all");
    expect(
      screen.getByText(
        "Account-scoped operational conditions and their history.",
      ),
    ).toBeTruthy();
  });
  it("shows the stable condition code and full current evidence for resolved history", () => {
    mocks.detail = {
      id: 4, tradingAccountId: 7, code: "CONFLICTING_EXIT_RESERVATION", source: "EXIT_VERIFICATION", status: "RESOLVED", severity: "ERROR",
      title: "Exit blocked by existing sell order", message: "Close blocked.", detailsJson: {
        brokerOrderId: "external-qqq", type: "limit", side: "sell", status: "NEW", limitPrice: "800",
        qty: "3", filledQty: "0", remainingQty: "3", brokerHeldQty: "3", brokerAvailableQty: "0",
      }, occurrenceCount: 2, firstObservedAt: "2026-09-01T10:00:00Z", lastObservedAt: "2026-09-01T11:00:00Z",
      revision: 3, resolutionPolicy: "AUTHORITATIVE_ONLY", acknowledgedAt: null, resolvedAt: "2026-09-01T12:00:00Z",
      resolutionReason: "Reservation absent.", trackedPositionId: 79, orderIntentId: 272, brokerOrderId: null,
      tradingAccount: { id: 7, displayName: "Bobby Paper", environment: "PAPER" },
      links: { account: "/accounts/7", position: "/positions/79", order: null, reconciliation: "/reconciliation", systemEvents: "/events" },
      allowedActions: { acknowledge: false, manualResolve: false }, evidenceEvents: [],
    };
    renderPage("/operational-attention?status=all&attention=4");
    expect(screen.getByText("CONFLICTING_EXIT_RESERVATION")).toBeTruthy();
    expect(screen.getByText(/external-qqq/)).toBeTruthy();
    expect(screen.getByText(/remainingQty/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /cancel|replace|quantity/i })).toBeNull();
  });
  it("explains that repeated observations are aggregated without manufacturing events", () => {
    mocks.detail = {
      id: 4, tradingAccountId: 7, code: "CONFLICTING_EXIT_RESERVATION", source: "EXIT_VERIFICATION", status: "OPEN", severity: "ERROR",
      title: "Exit blocked", message: "Close blocked.", detailsJson: {}, occurrenceCount: 3,
      firstObservedAt: "2026-09-01T10:00:00Z", lastObservedAt: "2026-09-01T15:27:43Z", revision: 3,
      resolutionPolicy: "AUTHORITATIVE_ONLY", acknowledgedAt: null, resolvedAt: null, resolutionReason: null,
      trackedPositionId: 79, orderIntentId: 272, brokerOrderId: null,
      tradingAccount: { id: 7, displayName: "Bobby Paper", environment: "PAPER" },
      links: { account: "/accounts/7", position: "/positions/79", order: null, reconciliation: "/reconciliation", systemEvents: "/events" },
      allowedActions: { acknowledge: true, manualResolve: false }, evidenceEvents: [],
    };
    renderPage("/operational-attention?attention=4");
    expect(screen.getByText(/Occurrences:/).parentElement?.textContent).toContain("Occurrences: 3");
    expect(screen.getByText(/2 repeated observations were aggregated/).textContent).toContain("Most recently observed at");
    expect(screen.queryByText(/evidence event/i)).toBeNull();
  });
  it("does not display internal active-key errors", () => {
    mocks.detailError = new Error("Active attention key conflicts with a different condition.");
    renderPage("/operational-attention?attention=4");
    expect(screen.getByText("Operational attention details could not be refreshed. Retry shortly.")).toBeTruthy();
    expect(screen.queryByText(/active attention key/i)).toBeNull();
  });
});

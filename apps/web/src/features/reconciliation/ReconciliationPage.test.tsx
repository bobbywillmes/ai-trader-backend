// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "../tradingAccounts/types";

const accounts = [
  { id: 1, displayName: "Bobby Paper", accountHolderName: "Bobby W", broker: "ALPACA", environment: "PAPER", status: "ACTIVE", credential: { exists: true, status: "ACTIVE" } },
  { id: 2, displayName: "Bobby Live", accountHolderName: "Bobby W", broker: "ALPACA", environment: "LIVE", status: "NEEDS_CREDENTIALS", credential: { exists: false, status: null } },
] as TradingAccount[];
const mocks = vi.hoisted(() => ({ mutate: vi.fn(), requestedAccountIds: [] as number[], result: undefined as unknown }));

vi.mock("../tradingAccounts/hooks", () => ({
  useTradingAccount: (id: number) => {
    mocks.requestedAccountIds.push(id);
    const account = accounts.find((candidate) => candidate.id === id);
    return { data: account ? { account } : undefined, isLoading: false, isError: false, error: null };
  },
  useTradingAccounts: () => ({ data: { accounts }, isLoading: false, isError: false, error: null }),
}));
vi.mock("./hooks", () => ({
  useRunReconciliation: (id: number) => ({ mutate: (payload: unknown) => mocks.mutate(id, payload), data: mocks.result, error: null, isError: false, isPending: false }),
}));
vi.mock("../../lib/api", () => ({
  getAdminToken: () => "token",
  ApiError: class ApiError extends Error { status = 500; },
}));

import { ReconciliationPage, ReconciliationTargetPage } from "./ReconciliationPage";

function Location() { const location = useLocation(); return <output aria-label="location">{location.pathname}{location.search}</output>; }
function renderCanonical(entry: string) {
  return render(<MantineProvider><MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/trading-accounts/:id/reconciliation" element={<><ReconciliationPage /><Location /></>} />
    <Route path="/trading-accounts/:id" element={<Location />} />
  </Routes></MemoryRouter></MantineProvider>);
}
function renderLegacy(entry: string) {
  return render(<MantineProvider><MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/system/reconciliation" element={<><ReconciliationTargetPage /><Location /></>} />
    <Route path="/trading-accounts/:id/reconciliation" element={<Location />} />
  </Routes></MemoryRouter></MantineProvider>);
}

beforeEach(() => { mocks.mutate.mockClear(); mocks.requestedAccountIds.length = 0; mocks.result = undefined; });
afterEach(cleanup);

describe("account-specific Reconciliation routing", () => {
  it("uses explicit persisted-effect counter labels", () => {
    mocks.result = {
      ok: true, dryRun: false, findings: [], eventCount: 0, attentionUpdateCount: 1,
      operationalAttentionTransitionCount: 1, legacyExitStateProjectionCount: 0,
      skippedDuplicateEventCount: 1, persistedEvents: true, persistedAttention: true,
      runIdentifier: "run-1", account: { tradingAccountId: 1, displayName: "Bobby Paper", environment: "PAPER" },
    };
    renderCanonical("/trading-accounts/1/reconciliation");
    expect(screen.getByText("Finding events")).toBeTruthy();
    expect(screen.getByText("Persisted attention effects").parentElement?.textContent).toContain("1");
    expect(screen.getByText("Duplicate finding events skipped")).toBeTruthy();
    expect(screen.queryByText("Attention updates")).toBeNull();
  });
  it("uses the path account even when dormant operational scope names another account", async () => {
    renderCanonical("/trading-accounts/2/reconciliation?account=1");
    expect(screen.getByRole("heading", { name: "Bobby Live" })).toBeTruthy();
    expect(screen.getByLabelText("LIVE status")).toBeTruthy();
    expect(screen.getByText(/does not have active verified broker credentials/)).toBeTruthy();
    expect(mocks.requestedAccountIds).toContain(2);
    expect(mocks.requestedAccountIds).not.toContain(1);
  });

  it("shows PAPER explicitly and sends a dry run to the path account", async () => {
    renderCanonical("/trading-accounts/1/reconciliation?account=2");
    expect(screen.getByLabelText("PAPER status")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: /Run dry check/ }));
    expect(mocks.mutate).toHaveBeenCalledWith(1, { persistEvents: false, persistAttention: false });
  });

  it("preserves dormant scope while switching the route target", async () => {
    renderCanonical("/trading-accounts/1/reconciliation?account=2");
    const selector = screen.getByRole("combobox", { name: "Reconciliation target" });
    await userEvent.setup().click(selector);
    await userEvent.setup().click(screen.getByRole("option", { name: /Bobby Live/, hidden: true }));
    expect(screen.getByLabelText("location").textContent).toBe("/trading-accounts/2/reconciliation?account=2");
  });

  it("makes the persisted target and no-broker-mutation posture explicit", async () => {
    renderCanonical("/trading-accounts/1/reconciliation?account=all");
    await userEvent.setup().click(screen.getByRole("button", { name: "Persist events + attention" }));
    expect(screen.getByRole("dialog").textContent).toContain("Bobby Paper");
    expect(screen.getByRole("dialog").textContent).toContain("PAPER");
    expect(screen.getByRole("dialog").textContent).toContain("does not place, cancel, or modify broker orders or positions");
  });
});

describe("legacy Reconciliation compatibility", () => {
  it("redirects a concrete explicit scope and preserves it", () => {
    renderLegacy("/system/reconciliation?account=2");
    expect(screen.getByLabelText("location").textContent).toBe("/trading-accounts/2/reconciliation?account=2");
  });

  it("does not silently default from ALL scope", () => {
    renderLegacy("/system/reconciliation?account=all");
    expect(screen.getByRole("heading", { name: "Choose a Reconciliation target" })).toBeTruthy();
    expect(screen.getByText(/No default account will be selected/)).toBeTruthy();
    expect(screen.getByLabelText("location").textContent).toBe("/system/reconciliation?account=all");
  });
});

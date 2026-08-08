// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LifecycleExercise, SubscriptionEntryCandidate } from "./types";

const mocks = vi.hoisted(() => ({
  candidateSubscriptionId: null as number | null,
  previewExplicit: vi.fn(),
  launch: vi.fn(),
}));

const candidate = (id: number, environment: "PAPER" | "LIVE", selectable: boolean, reasons: Array<{ code: string; message: string }> = []): SubscriptionEntryCandidate => ({
  tradingAccountSubscriptionId: id,
  subscriptionId: 7,
  tradingAccountId: id + 100,
  subscription: { key: "spy", displayName: "SPY Core" },
  tradingAccount: { displayName: environment === "LIVE" ? "Primary Live" : `Paper Account ${id}`, environment, status: "ACTIVE", tradingEnabled: true, killSwitchEnabled: false, credentialStatus: "ACTIVE" },
  accountHolder: { id, name: `Holder ${id}`, email: `holder${id}@example.com`, enabled: true },
  accessMembers: [],
  assignment: { enabled: true, entriesEnabled: true, exitsEnabled: true, sizingType: "FIXED_QTY", fixedQty: 1, maxPositionNotional: null, reservedNotional: null, minPositionNotional: null, maxQty: null },
  allocation: { id, key: `allocation-${id}`, displayName: `Allocation ${id}`, enabled: true },
  selectable,
  unavailableReasons: reasons,
});

const exercise = (id: number, selectionMode: LifecycleExercise["selectionMode"]): LifecycleExercise => ({
  id, name: `Exercise ${id}`, reason: "Test", environment: "PAPER", exerciseType: "SUBSCRIPTION_ENTRY", containsLiveTargets: false,
  previewVersion: 2, previewFingerprint: "fingerprint", status: "PREVIEWED", selectionMode, requestedUserIdsJson: [], selectionResultsJson: [], summaryJson: null,
  previewedAt: "2026-08-07T12:00:00Z", previewExpiresAt: "2099-08-07T12:05:00Z", launchedAt: null, cancelledAt: null, createdAt: "2026-08-07T12:00:00Z",
  subscription: { id: 7, key: "spy", name: "SPY Core" }, createdByUser: { id: 1, name: "Owner", email: "owner@example.com" }, _count: { targets: selectionMode === "EXPLICIT_ASSIGNMENTS" ? 2 : 1 },
});

const candidates = [candidate(4, "PAPER", true), candidate(8, "PAPER", false, [{ code: "ASSIGNMENT_DISABLED", message: "Entries are disabled for this deployment." }]), candidate(9, "LIVE", false)];
const history = [exercise(1, "EXPLICIT_ASSIGNMENTS"), exercise(2, "SELECTED_USERS"), exercise(3, "ALL_ELIGIBLE")];
let historyRows = history;

vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: { queryKey: string[] }) => queryKey[0] === "subscriptions" ? { data: [{ id: 7, key: "spy", name: "SPY Core" }, { id: 99, key: "unused", name: "Unused Subscription" }] } : {} }));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("./hooks", () => ({
  useLifecycleExercises: () => ({ data: { exercises: historyRows }, isLoading: false, isFetching: false, refetch: vi.fn() }),
  useSubscriptionEntryCandidates: (_token: string, subscriptionId: number | null) => {
    mocks.candidateSubscriptionId = subscriptionId;
    return { data: subscriptionId ? { candidates } : undefined, isLoading: false, isFetching: false, isError: false, refetch: vi.fn().mockResolvedValue({ data: { candidates } }) };
  },
  useLifecycleExerciseMutations: () => ({
    previewExplicit: { mutateAsync: mocks.previewExplicit, isPending: false, isError: false, error: null },
    launch: { mutateAsync: mocks.launch, isPending: false, isError: false, error: null },
  }),
}));

import { LifecycleExercisesPage } from "./LifecycleExercisesPage";

function renderPage() {
  return render(<MantineProvider><MemoryRouter><LifecycleExercisesPage /></MemoryRouter></MantineProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  historyRows = history;
  mocks.candidateSubscriptionId = null;
  mocks.previewExplicit.mockResolvedValue({ exercise: exercise(10, "EXPLICIT_ASSIGNMENTS") });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Lifecycle Exercises creation", () => {
  it("offers only the TradingAccount workflow while preserving legacy history labels", async () => {
    renderPage();
    expect(screen.getByText("Select TradingAccounts")).toBeTruthy();
    expect(screen.getByText("How this works")).toBeTruthy();
    expect(screen.getByText("Currently PAPER only")).toBeTruthy();
    expect(screen.getByText(/can place PAPER orders and open PAPER positions on every eligible selected account/)).toBeTruthy();
    expect(screen.getByText(/submits a PAPER entry for every account that is eligible at launch/)).toBeTruthy();
    expect(screen.queryByText("Users")).toBeNull();
    expect(screen.queryByText("Legacy User selection")).toBeNull();
    expect(screen.queryByText("Selected account holders")).toBeNull();
    expect(screen.queryByPlaceholderText("Selection mode")).toBeNull();
    expect(screen.getByText(/Subscription Entry · Selected users/)).toBeTruthy();
    expect(screen.getByText(/Subscription Entry · All eligible users\/accounts/)).toBeTruthy();
    expect(screen.getByText(/Subscription Entry · 2 selected TradingAccounts/)).toBeTruthy();
  });

  it("loads deployments, disables LIVE and unavailable PAPER rows, and previews exact selected assignment IDs", async () => {
    mocks.previewExplicit.mockResolvedValue({ exercise: {
      ...exercise(10, "EXPLICIT_ASSIGNMENTS"),
      targets: [{
        id: 100, tradingAccountId: 104, tradingAccountSubscriptionId: 4, status: "READY", blockersJson: [], warningsJson: [], environment: "PAPER",
        resolvedQuantity: 3, estimatedPrice: 314.09, estimatedNotional: 942.27, orderIntentId: null, reconciledAt: null,
        readinessJson: {
          sizing: { qty: 3, snapshot: { sizingType: "MAX_NOTIONAL", maxPositionNotional: 1_000, latestPriceAt: "2026-08-07T12:00:00Z", latestPriceSource: "last_trade" } },
          session: { status: "allowed", marketOpen: true },
          risk: { allowed: true, details: {
            usage: { activePositionCount: 1, pendingEntryPositionCount: 1, currentAccountPositionSlots: 2, currentAccountExposure: 2_000, projectedAccountExposure: 2_942.27 },
            effectiveEntryLimits: { limits: { maxOpenPositions: { value: 5 } }, authoritativeTotalExposure: { value: 10_000 } },
            allocationRisk: { limits: { maxAllocatedNotional: 5_000 }, usage: { currentAllocatedNotional: 1_000, projectedAllocatedNotional: 1_942.27 } },
          } },
        },
      }],
    } });
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText("Select a Subscription"));
    await user.click(await screen.findByText("SPY Core (spy)"));
    await waitFor(() => expect(mocks.candidateSubscriptionId).toBe(7));

    expect(screen.getByText("Primary Live")).toBeTruthy();
    expect(screen.getByText("Live exercises are not supported yet.")).toBeTruthy();
    expect(screen.getByText("Entries are disabled for this deployment.")).toBeTruthy();
    expect((screen.getByLabelText("Select Primary Live assignment 9") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Select Paper Account 8 assignment 8") as HTMLInputElement).disabled).toBe(true);

    await user.click(screen.getByLabelText("Select Paper Account 4 assignment 4"));
    await user.click(screen.getByRole("button", { name: "Preview frozen targets" }));
    expect(mocks.previewExplicit).toHaveBeenCalledWith(expect.objectContaining({ subscriptionId: 7, tradingAccountSubscriptionIds: [4], environment: "PAPER" }));
    expect(await screen.findByText("Frozen preview")).toBeTruthy();
    expect(screen.getByText("Paper Account 4")).toBeTruthy();
    expect(screen.getByText(/Selected target · Holder 4 · Assignment #4/)).toBeTruthy();
    expect(screen.getByText("Allocation 4")).toBeTruthy();
    expect(screen.getByText("1 open + 1 pending/unresolved + 1 proposed = 3 / 5")).toBeTruthy();
    expect(screen.queryByText("Warnings")).toBeNull();
    expect(screen.queryByText("Eligible notional")).toBeNull();
    await user.click(screen.getByRole("button", { name: /View risk and sizing details/ }));
    expect(screen.getByText("$1,000.00 maximum notional")).toBeTruthy();
    expect(screen.getByText("3 shares at $314.09 = $942.27")).toBeTruthy();
    expect(screen.getByText("$2,000.00 current · $2,942.27 projected · $10,000.00 max")).toBeTruthy();
    expect(screen.getByText("$1,000.00 current · $1,942.27 projected · $5,000.00 max")).toBeTruthy();
    expect(screen.queryByText("Select TradingAccounts")).toBeNull();
    expect(screen.getByRole("button", { name: "Launch PAPER exercise" })).toBeTruthy();
  });

  it("shows account position slots even when the market-session check blocks entry", async () => {
    mocks.previewExplicit.mockResolvedValue({ exercise: {
      ...exercise(11, "EXPLICIT_ASSIGNMENTS"),
      targets: [{
        id: 101, tradingAccountId: 104, tradingAccountSubscriptionId: 4, status: "BLOCKED",
        blockersJson: [{ code: "MARKET_CLOSED", message: "Regular market is closed." }], warningsJson: [], environment: "PAPER",
        resolvedQuantity: 3, estimatedPrice: 314.09, estimatedNotional: 942.27, orderIntentId: null, reconciledAt: null,
        readinessJson: { risk: { details: { usage: { activePositionCount: 1, pendingEntryPositionCount: 0, currentAccountPositionSlots: 1 }, effectiveEntryLimits: { limits: { maxOpenPositions: { value: 5 } } } } } },
      }],
    } });
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText("Select a Subscription"));
    await user.click(await screen.findByText("SPY Core (spy)"));
    await user.click(screen.getByLabelText("Select Paper Account 4 assignment 4"));
    await user.click(screen.getByRole("button", { name: "Preview frozen targets" }));

    expect(await screen.findByText("Account position slots")).toBeTruthy();
    expect(screen.getByText("1 open + 0 pending/unresolved + 1 proposed = 2 / 5")).toBeTruthy();
    expect(screen.getByText("Regular market is closed.")).toBeTruthy();
  });

  it("replaces launch with a fresh-preview action after expiration", async () => {
    mocks.previewExplicit.mockResolvedValue({ exercise: { ...exercise(12, "EXPLICIT_ASSIGNMENTS"), previewExpiresAt: "2020-01-01T00:00:00Z" } });
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByPlaceholderText("Select a Subscription"));
    await user.click(await screen.findByText("SPY Core (spy)"));
    await user.click(screen.getByLabelText("Select Paper Account 4 assignment 4"));
    await user.click(screen.getByRole("button", { name: "Preview frozen targets" }));

    expect(await screen.findByText("Expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Launch PAPER exercise" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create fresh preview" }));
    expect(screen.getByText("Create Subscription Entry exercise")).toBeTruthy();
  });

  it("limits history to ten rows and paginates the filtered result set", async () => {
    historyRows = Array.from({ length: 12 }, (_, index) => exercise(12 - index, index % 2 ? "SELECTED_USERS" : "EXPLICIT_ASSIGNMENTS"));
    renderPage();

    expect(screen.getByText("Showing 1–10 of 12")).toBeTruthy();
    expect(screen.getByText("#12 Exercise 12")).toBeTruthy();
    expect(screen.queryByText("#2 Exercise 2")).toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Showing 11–12 of 12")).toBeTruthy();
    expect(screen.getByText("#2 Exercise 2")).toBeTruthy();
    expect(screen.queryByText("#12 Exercise 12")).toBeNull();
  });
});

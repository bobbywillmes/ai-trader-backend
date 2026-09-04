// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifecycleRepairCase, LifecycleRepairExecution } from "./api";
import { LifecycleRepairCaseDetail } from "./LifecycleRepairCaseDetail";

const snapshot = {
  capturedAt: "2026-08-16T01:00:00.000Z",
  subscription: { id: 38, key: "aapl_dip_core", name: "AAPL Dip Core" },
  strategy: { id: 7, key: "dip_n_ride_stock", name: "Dip N Ride - Stock" },
  exitProfile: { id: 8, key: "exit_stock_dip_core_target", name: "Stock Dip Core Target", targetPct: 3, stopLossPct: 2, trailingStopPct: 1, maxHoldDays: 5, exitMode: "fixed_target", takeProfitBehavior: "immediate" },
};
const success: LifecycleRepairExecution = {
  id: 10, result: "SUCCEEDED", reason: "Recover deterministic ownership.", executedAt: "2026-08-16T01:03:00.000Z",
  executedByUser: { id: 1, name: "Bobby Owner", email: "owner@example.test" }, beforeJson: {},
  afterJson: { trackedPosition: { subscriptionId: 38, configSnapshotJson: snapshot }, positionExitState: { id: 73, exitProfileKey: "exit_stock_dip_core_target" } },
  validationJson: { valid: true, checks: { attribution: true, frozenSnapshot: true, exitStateHydrated: true, brokerMutationPerformed: false } }, failureJson: null,
};
const base: LifecycleRepairCase = {
  id: 3, generation: 1, operationalAttentionId: null, supersedesCaseId: null, repairType: "RESOLVE_POSITION_ATTRIBUTION", repairVersion: 1, impact: "LOCAL_ONLY", targetType: "TrackedPosition", targetId: "73",
  confidence: "DETERMINISTIC", resolutionSource: "BROKER_CLIENT_ORDER_ID", diagnosticFingerprint: "diagnostic-fingerprint-73", configurationFingerprint: "config-fingerprint-73",
  evidenceJson: { confidence: "DETERMINISTIC", brokerOrderId: "17ab373f-cf57-43bc-a30c-d320a099c656", clientOrderId: "ai-entry-tas4-fc7fee7e1652deb4f9d502c49f99baaaaadec24f3b3112f504977ca594b85e92", assignment: { id: 4, subscriptionId: 38, subscriptionKey: "aapl_dip_core", exitProfileId: 8, exitProfileKey: "exit_stock_dip_core_target", symbol: "AAPL" }, activities: [{ id: 214, qty: 2, price: 303.18 }, { id: 215, qty: 1, price: 303.18 }], fillQty: 3, weightedAveragePrice: 303.18 },
  candidateResolutionsJson: [{ assignmentId: 4, subscriptionId: 38, subscriptionKey: "aapl_dip_core" }, { assignmentId: 6, subscriptionId: 40, subscriptionKey: "aapl_momentum_core" }],
  rejectedAlternativesJson: [{ assignmentId: 6, reason: "Broker client-order identity resolves specifically to TAS 4." }],
  beforeJson: { symbol: "AAPL", side: "long", qty: 3, avgEntryPrice: 303.18 },
  proposedMutationsJson: { trackedPosition: { subscriptionId: { before: null, after: 38 }, tradingAccountSubscriptionId: { before: null, after: 4 }, configSnapshotJson: { before: null, after: snapshot }, configSnapshotCapturedAt: { before: null, after: snapshot.capturedAt } }, positionExitState: { action: "HYDRATE", after: { exitProfileKey: "exit_stock_dip_core_target" } } },
  preconditionsJson: { positionAttributionMustRemainNull: true, exitStateMustRemainPristine: true, configurationFingerprint: "config-fingerprint-73" },
  brokerImpactJson: { laterWorkerWarning: "After a successful repair, ordinary lifecycle workers may resume normal evaluation. On PAPER, subsequent exit evaluation may create broker actions." },
  executableAtCreation: true, nonExecutableReasonsJson: [], createdAt: "2026-08-16T01:00:01.000Z", expiresAt: "2026-08-16T01:10:00.000Z",
  expired: false, superseded: false, executed: false, executable: true, tradingAccount: { id: 1, displayName: "Bobby Paper", environment: "PAPER" }, executions: [],
};

function renderDetail(item: LifecycleRepairCase = base, onDiagnoseAgain = vi.fn()) {
  const onApply = vi.fn();
  render(<MantineProvider><LifecycleRepairCaseDetail item={item} onApply={onApply} onDiagnoseAgain={onDiagnoseAgain} /></MantineProvider>);
  return { onApply, onDiagnoseAgain };
}

const historicalAction = (id: number, actionType: "TERMINALIZE_ORDER_LIFECYCLE" | "LINK_ENTRY_LIFECYCLE_TO_POSITION", status: "PROPOSED" | "APPROVED" = "PROPOSED") => ({
  id, actionType, ordinal: id, classification: actionType === "TERMINALIZE_ORDER_LIFECYCLE" ? "DETERMINISTIC" as const : "OPERATOR_CONFIRMATION_REQUIRED" as const,
  generation: 1, supersedesActionId: null, reconsiderationReason: null, status, revision: 1,
  actionFingerprint: `fingerprint-${id}`, proposedMutationsJson: {}, preconditionsJson: {}, evidenceJson: {},
  decisionReason: status === "APPROVED" ? "Approved for regression test." : null, decidedAt: status === "APPROVED" ? "2026-09-04T10:00:00Z" : null,
  beforeJson: {}, afterJson: null, verificationJson: null, executions: [],
});

const historical = (actions: NonNullable<LifecycleRepairCase["actions"]>): LifecycleRepairCase => ({
  ...base,
  repairType: "REPAIR_HISTORICAL_ENTRY_LIFECYCLE",
  targetType: "BrokerOrder",
  targetId: "91",
  evidenceJson: {
    unresolvedComponents: ["STALE_ORDER_STATUS", "MISSING_POSITION_LINK"],
    lifecycle: { brokerOrder: { id: 91, symbol: "ZXQ", status: "new", brokerOrderId: "synthetic-order" }, orderIntent: { id: 92, status: "new", qty: 1 } },
    fillAssessment: { summary: { cumulativeQty: 1, leavesQty: 0, weightedAveragePrice: 100 } },
    positionCandidates: [{ trackedPositionId: 93, rejectionReasons: ["price_outside_tolerance"], comparison: { fillDerivedExpectedPrice: 100, candidateAverageEntryPrice: 100.5, absolutePriceDifference: 0.5, priceTolerance: 0.0001, absoluteTimeDifferenceMs: 1000, timeToleranceMs: 300000 } }],
  },
  actions,
});

afterEach(cleanup);

describe("Lifecycle Repair operator review", () => {
  it("renders deterministic evidence, recommendation, rejection, mutations, and broker safety in human-readable form", () => {
    renderDetail();
    expect(screen.getByRole("heading", { name: "Position 73 · AAPL" })).toBeTruthy();
    expect(screen.getByText("Bobby Paper")).toBeTruthy();
    expect(screen.getByText("17ab373f-cf57-43bc-a30c-d320a099c656")).toBeTruthy();
    expect(screen.getAllByText("AAPL Dip Core").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Dip N Ride - Stock").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Stock Dip Core Target").length).toBeGreaterThan(0);
    expect(screen.getByText("AAPL Momentum Core")).toBeTruthy();
    expect(screen.getAllByText(/resolves specifically to TAS 4/).length).toBeGreaterThan(0);
    expect(screen.getByText("TrackedPosition.subscriptionId")).toBeTruthy();
    expect(screen.getAllByText("Captured").length).toBeGreaterThan(0);
    const safety = screen.getByText("Repair broker impact").closest("[role='alert']")?.textContent ?? "";
    expect(safety).toContain("Broker writes during repair: NONE");
    expect(safety).toContain("Orders submitted during repair: NONE");
  });

  it("allows an executable PAPER repair", async () => {
    const { onApply } = renderDetail();
    await userEvent.setup().click(screen.getByRole("button", { name: "Apply deterministic PAPER repair" }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it("shows LIVE as read-only", () => {
    renderDetail({ ...base, tradingAccount: { ...base.tradingAccount, environment: "LIVE" }, executable: false });
    expect(screen.getByText(/Apply is prohibited for LIVE/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "LIVE read-only" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains why an ambiguous case cannot be repaired automatically", () => {
    renderDetail({ ...base, confidence: "AMBIGUOUS", executableAtCreation: false, executable: false, nonExecutableReasonsJson: [{ code: "EVIDENCE_NOT_DETERMINISTIC", message: "Multiple unresolved assignments remain." }] });
    expect(screen.getAllByText("Automatic repair unavailable — manual review required.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Multiple unresolved assignments remain/).length).toBeGreaterThan(0);
  });

  it.each([["expired", { expired: true, executable: false }], ["superseded", { superseded: true, executable: false }]] as const)("offers Diagnose Again for a %s case", async (_label, state) => {
    const onDiagnoseAgain = vi.fn(); renderDetail({ ...base, ...state }, onDiagnoseAgain);
    const buttons = screen.getAllByRole("button", { name: "Diagnose Again" });
    await userEvent.setup().click(buttons[0]!);
    expect(onDiagnoseAgain).toHaveBeenCalledOnce();
  });

  it("summarizes a successful execution", () => {
    renderDetail({ ...base, executed: true, executable: false, executions: [success] });
    const result = screen.getByText("Execution 10").closest("div[data-result]") as HTMLElement;
    expect(within(result).getByText("SUCCEEDED")).toBeTruthy();
    expect(within(result).getByText(/Attribution/)).toBeTruthy();
    expect(within(result).getByText(/Frozen snapshot/)).toBeTruthy();
    expect(within(result).getByText(/Exit state hydrated/)).toBeTruthy();
    expect(within(result).getByText(/Broker mutation performed: NO/)).toBeTruthy();
    expect(within(result).getByText("Bobby Owner")).toBeTruthy();
  });

  it("summarizes a failed execution without hiding raw details", () => {
    const failed = { ...success, id: 11, result: "FAILED" as const, afterJson: null, validationJson: null, failureJson: { message: "Configuration changed before Apply." } };
    renderDetail({ ...base, executions: [failed] });
    expect(screen.getByText("Configuration changed before Apply.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raw execution details" })).toBeTruthy();
  });

  it("keeps raw evidence collapsed by default and safely wrapped when expanded", async () => {
    renderDetail();
    const disclosure = screen.getByRole("button", { name: "Raw evidence" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const raw = screen.getByText(/"brokerOrderId"/);
    expect(raw.tagName).toBe("PRE");
    expect(raw.className).toContain("raw");
  });

  it("keeps typed reasons independent and enables approval only for the populated action", async () => {
    const actions = [historicalAction(11, "TERMINALIZE_ORDER_LIFECYCLE"), historicalAction(12, "LINK_ENTRY_LIFECYCLE_TO_POSITION")];
    renderDetail(historical(actions));
    const user = userEvent.setup();
    const reasons = screen.getAllByRole("textbox", { name: "Required action reason" }) as HTMLInputElement[];
    const approve = screen.getAllByRole("button", { name: "Approve" }) as HTMLButtonElement[];
    expect(approve[0]!.disabled).toBe(true);
    expect(approve[1]!.disabled).toBe(true);
    await user.type(reasons[0]!, "Terminalize");
    expect(reasons[0]!.value).toBe("Terminalize");
    expect(reasons[1]!.value).toBe("");
    expect(approve[0]!.disabled).toBe(false);
    expect(approve[1]!.disabled).toBe(true);
    await user.type(reasons[1]!, "Link");
    expect(reasons[0]!.value).toBe("Terminalize");
    expect(reasons[1]!.value).toBe("Link");
    expect(screen.getByTestId("historical-entry-repair-case-detail")).toBeTruthy();
  });

  it("requires and retains the exact approved-action confirmation", async () => {
    renderDetail(historical([historicalAction(13, "TERMINALIZE_ORDER_LIFECYCLE", "APPROVED")]));
    const user = userEvent.setup();
    const reason = screen.getByRole("textbox", { name: "Required action reason" }) as HTMLInputElement;
    const confirmation = screen.getByRole("textbox", { name: "Type TERMINALIZE HISTORICAL ORDER LIFECYCLE" }) as HTMLInputElement;
    const apply = screen.getByRole("button", { name: "Apply approved action" }) as HTMLButtonElement;
    await user.type(reason, "Apply synthetic terminalization");
    await user.type(confirmation, "TERMINALIZE HISTORICAL ORDER");
    expect(apply.disabled).toBe(true);
    await user.type(confirmation, " LIFECYCLE");
    expect(confirmation.value).toBe("TERMINALIZE HISTORICAL ORDER LIFECYCLE");
    expect(reason.value).toBe("Apply synthetic terminalization");
    expect(apply.disabled).toBe(false);
  }, 15_000);

  it("shows operator-facing candidate price and timing comparisons", () => {
    renderDetail(historical([]));
    expect(screen.getAllByText("$100.00").length).toBeGreaterThan(0);
    expect(screen.getByText("$100.50")).toBeTruthy();
    expect(screen.getByText("$0.50")).toBeTruthy();
    expect(screen.getByText("$0.00")).toBeTruthy();
    expect(screen.getByText("1000 ms")).toBeTruthy();
    expect(screen.getByText("300000 ms")).toBeTruthy();
    expect(screen.getAllByText(/price_outside_tolerance/).length).toBeGreaterThan(0);
  });
});

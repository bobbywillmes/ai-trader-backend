// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerOpportunity, ComparisonState, EvidenceAttempt, EvidenceGate, EvidenceState, OrderOperationalEvidenceResponse } from "./types";

const mocks = vi.hoisted(() => ({ query: { data: null as OrderOperationalEvidenceResponse | null, isLoading: false, isError: false, error: null as Error | null, refetch: vi.fn() } }));
vi.mock("./hooks", () => ({ useOrderOperationalEvidence: vi.fn(() => mocks.query) }));
import { OrderOperationalEvidence } from "./OrderOperationalEvidence";
import { useOrderOperationalEvidence } from "./hooks";

function renderEvidence() { return render(<MantineProvider><OrderOperationalEvidence orderIntentId={41} token="token" authorizationContext="account:7" expectedTradingAccountId={7} /></MantineProvider>); }
beforeEach(() => { vi.clearAllMocks(); mocks.query.data = fixture(); mocks.query.isLoading = false; mocks.query.isError = false; mocks.query.error = null; });
afterEach(cleanup);

describe("OrderOperationalEvidence", () => {
  it("keeps authoritative order status distinct from a compare-only BLOCKED outcome", () => {
    mocks.query.data = fixture({ intentOutcome: "BLOCKED", orderStatus: "submitted" }); renderEvidence();
    expect(useOrderOperationalEvidence).toHaveBeenCalledWith(41, 1, "token", "account:7", true);
    expect(screen.getByRole("alert").textContent).toContain("authoritative OrderIntent status remains Submitted"); expect(screen.getAllByText("Blocked").length).toBeGreaterThan(0); expect(screen.getByText(/did not allow, reject, cancel, retry, or modify/)).toBeTruthy();
  });
  it.each([
    ["PRE_ROLLOUT", "predates the capture rollout"], ["UNENROLLED", "No applicable assignment enrollment"], ["LEGACY_UNKNOWN", "legacy or unknown"],
  ] as const)("renders neutral historical state %s", (state, message) => { mocks.query.data = fixture({ state }); renderEvidence(); expect(screen.getByText(new RegExp(message))).toBeTruthy(); });
  it("renders NONE_VISIBLE without fabricated gate rows", () => {
    mocks.query.data = fixture({ state: "NONE_VISIBLE", comparisonState: "INSUFFICIENT_EVIDENCE", gates: [] }); renderEvidence();
    expect(screen.getByText("This is a valid zero-gate result. No dimension rows are fabricated.")).toBeTruthy(); expect(screen.queryByText("Trend")).toBeNull();
  });
  it.each([["PENDING", "pending or waiting"], ["TECHNICAL_FAILURE", "technical failure"], ["TERMINAL_RETRY_EXHAUSTED", "exhausted its bounded"]] as const)("explains %s comparison state", (comparisonState, message) => { mocks.query.data = fixture({ comparisonState, gates: [] }); renderEvidence(); expect(screen.getAllByText(new RegExp(message, "i")).length).toBeGreaterThan(0); });
  it("selects among multiple opportunities and discloses pagination", async () => {
    mocks.query.data = fixture({ opportunities: 2, opportunityPages: 3 }); renderEvidence(); expect(screen.getByText(/Additional pages are not implied to be loaded/)).toBeTruthy();
    await userEvent.setup().click(screen.getByText("Opportunity 2")); expect(screen.getByText(/Sequence 2/)).toBeTruthy();
  });
  it("honors role-redacted rules and provenance", () => {
    const data = fixture(); delete data.intentStage.coverage!.marketComposition!.sourceSetFingerprint; delete data.intentStage.comparison.attempts[0]!.gates[0]!.allowedStates; delete data.brokerStage.opportunities[0]!.sourceSetFingerprint; mocks.query.data = data; renderEvidence();
    expect(screen.queryByText("Allowed states")).toBeNull(); expect(screen.queryByText(/Source fingerprint:/)).toBeNull();
  });
  it("shows a safe empty state when there is no OrderIntent", () => { render(<MantineProvider><OrderOperationalEvidence orderIntentId={null} token="token" authorizationContext="all" /></MantineProvider>); expect(screen.getByText("No OrderIntent")).toBeTruthy(); });
  it("changes authorization context when the account scope changes", () => {
    const view = renderEvidence();
    view.rerender(<MantineProvider><OrderOperationalEvidence orderIntentId={41} token="token" authorizationContext="account:8" expectedTradingAccountId={7} /></MantineProvider>);
    expect(useOrderOperationalEvidence).toHaveBeenLastCalledWith(41, 1, "token", "account:8", true);
  });
});

function fixture(options: { state?: EvidenceState; comparisonState?: ComparisonState; gates?: EvidenceGate[]; intentOutcome?: EvidenceAttempt["outcome"]; orderStatus?: string; opportunities?: number; opportunityPages?: number } = {}): OrderOperationalEvidenceResponse {
  const gate = { id: 1, ordinal: 1, dimension: "TREND", algorithmVersion: "TREND_V1", requirement: "REQUIRED", outcome: "PASS", observedState: "UP", sourceHealth: "AVAILABLE", sourceAssessmentId: 8, allowedStates: ["UP"], reasonCode: "STATE_ALLOWED", createdAt: "2026-10-12T12:00:00Z" } as const;
  const attempt = { id: 2, attempt: 1, evidenceAsOf: "2026-10-12T12:00:00Z", evaluationVersion: "ORDER_INTENT_MARKET_POLICY_COMPARISON_V1", enrollmentDisposition: "ACTIVE", outcome: options.intentOutcome ?? "ALLOWED", reasonCode: options.intentOutcome === "BLOCKED" ? "STATE_NOT_ALLOWED" : "ALL_REQUIRED_GATES_PASS", authority: "COMPARE_ONLY", tradingEffect: "NONE", createdAt: "2026-10-12T12:00:01Z", gates: options.gates ?? [gate] } as EvidenceAttempt;
  const count = options.opportunities ?? 1;
  const opportunities: BrokerOpportunity[] = Array.from({ length: count }, (_, index) => ({ id: 100 + index, opportunitySequence: index + 1, clientOrderId: "client", enrollmentGenerationId: 3, policyRevisionId: 4, marketRegimeAssessmentId: 12, sourceSetFingerprint: "fingerprint", compositionCapture: "EXACT", applicability: "APPLICABLE_ACTIVE", comparisonMode: "COMPARE_ONLY", tradingEffect: "NONE", opportunityAt: `2026-10-12T12:0${index}:00Z`, createdAt: "2026-10-12T12:00:00Z", comparison: { state: "COMPLETED", delivery: null, attempts: [attempt], attemptBounds: { returned: 1, limit: 20, total: 1, hasMore: false } }, eventPagination: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasMore: false } }));
  return { authority: { comparisonMode: "COMPARE_ONLY", tradingEffect: "NONE", enforcementAuthority: false }, orderIntent: { id: 41, source: "signal", symbol: "SPY", side: "buy", orderType: "market", timeInForce: "day", qty: 1, notional: null, limitPrice: null, extendedHours: false, clientOrderId: "client", status: options.orderStatus ?? "submitted", blockReason: null, createdAt: "2026-10-12T12:00:00Z", updatedAt: "2026-10-12T12:00:01Z", tradingAccountId: 7, tradingAccount: { id: 7, displayName: "Paper", broker: "ALPACA", environment: "PAPER" }, subscriptionId: 5, subscriptionKey: "spy", tradingAccountSubscriptionId: 9, assignment: { id: 9, subscription: { id: 5, key: "spy", name: "SPY Entry", strategy: { id: 4, key: "dip", name: "Dip" } } }, brokerOrders: [], trackedPositionId: null, trackedPosition: null }, intentStage: { state: options.state ?? "EXACT", rollout: null, coverage: { id: 1, provenance: "ACTIVE_EXACT", compositionCapture: options.state === "NONE_VISIBLE" ? "NONE_VISIBLE" : "EXACT", captureSchemaVersion: 2, comparisonMode: "COMPARE_ONLY", tradingEffect: "NONE", capturedAt: "2026-10-12T12:00:00Z", enrollmentGenerationId: 3, boundPolicyRevisionId: 4, activePolicyRevisionId: 4, marketRegimeAssessmentId: 12, enrollmentGeneration: { id: 3, generation: 2, status: "ACTIVE", strategyId: 4, policyRevisionId: 4, preparedAt: "2026-10-11T12:00:00Z", activatedAt: "2026-10-11T13:00:00Z", disabledAt: null }, boundPolicyRevision: { id: 4, revision: 3, status: "ACTIVE" }, activePolicyRevision: { id: 4, revision: 3, status: "ACTIVE" }, marketComposition: { id: 12, compositionVersion: "MARKET_REGIME_COMPOSITION_V1", targetAt: "2026-10-12T11:00:00Z", observedAt: "2026-10-12T12:00:00Z", dataThroughAt: "2026-10-12T11:45:00Z", validUntil: "2026-10-12T12:15:00Z", publicationStatus: "SUCCEEDED", evidenceHealth: "COMPLETE", publicationReasonCode: null, evidenceReasonCode: null, completedAt: "2026-10-12T12:00:00Z", sourceSetFingerprint: "fingerprint" } }, comparison: { state: options.comparisonState ?? "COMPLETED", delivery: null, attempts: options.comparisonState === "PENDING" || options.comparisonState === "TERMINAL_RETRY_EXHAUSTED" ? [] : [attempt], attemptBounds: { returned: 1, limit: 20, total: 1, hasMore: false } } }, brokerStage: { state: count > 1 ? "MULTIPLE_POST_OPPORTUNITIES" : "POST_OPPORTUNITY_RECORDED", stateSource: "RECORDED_EVIDENCE", opportunities, pagination: { page: 1, pageSize: 10, total: count * (options.opportunityPages ?? 1), totalPages: options.opportunityPages ?? 1, hasMore: (options.opportunityPages ?? 1) > 1 }, unboundMissingObservations: [], unboundEventPagination: { page: 1, pageSize: 25, total: 0, totalPages: 1, hasMore: false } }, relatedRecords: { entryDecisionId: 22, brokerOrderRecordIds: [], trackedPositionId: null, tradingAccountId: 7, accountSubscriptionId: 9, subscriptionId: 5, strategyId: 4, marketRegimeAssessmentIds: [12] } };
}

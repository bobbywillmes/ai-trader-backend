// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { LiveOperationsResponse } from "./types";

const mocks = vi.hoisted(() => ({ scope: { selectedAccount: null as null | { id: number; environment: "LIVE" | "PAPER" }, isAll: true }, data: null as LiveOperationsResponse | null }));
vi.mock("../tradingAccountScope/useTradingAccountScope", () => ({ useTradingAccountScope: () => mocks.scope }));
vi.mock("../tradingAccountScope/TradingAccountScopeSelector", () => ({ TradingAccountScopeSelector: () => <label>Account scope<select aria-label="Account scope"><option>All accounts</option></select></label> }));
vi.mock("./hooks", () => ({ useLiveOperations: () => ({ data: mocks.data, isLoading: false, isError: false }) }));
vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
import { LiveOperationsPage } from "./LiveOperationsPage";

const snapshot = { account: { id: 7, displayName: "Bobby Live", broker: "ALPACA", environment: "LIVE", status: "ACTIVE" }, generatedAt: "2026-08-25T20:00:00Z", health: "HEALTHY", summary: "One open Live position.", exposure: { openPositionCount: 1 }, positions: [], positionLifecycle: { health: "HEALTHY" }, exitCapability: { state: "READY", actionDue: false, strategyResolved: true, evaluatorHealth: "HEALTHY", authorizationActive: true, environmentWritePolicy: "ALLOWED" }, reconciliation: { health: "HEALTHY", findingCount: 0, freshness: "CURRENT", evidenceAt: "2026-08-25T20:00:00Z" }, workers: { health: "HEALTHY", items: [] }, entryPosture: { state: "DISARMED", authorizationActive: false, armingId: null }, safetyPosture: { tradingEnabled: false, killSwitchEnabled: true, riskReducingAuthorization: "ACTIVE", entryAuthorization: "INACTIVE", deploymentRole: "PRODUCTION_EXECUTOR", liveRiskReducingWritesAllowed: true, exclusiveWriterOwnershipProven: false }, completedCanary: { id: 2, completedAt: "2026-08-25T20:00:00Z" }, attentionReasons: [], nextOperatorAction: { code: "MONITORING", message: "No action required. Continue monitoring the open position." } } as const;
function response(): LiveOperationsResponse { return { generatedAt: snapshot.generatedAt, summary: { liveAccountCount: 1, accountsWithExposure: 1, openPositionCount: 1, accountsRequiringAttention: 0, accountsDegradedOrStale: 0, accountsWithActiveEntryArming: 0, health: "HEALTHY" }, accounts: [snapshot] as LiveOperationsResponse["accounts"] }; }
function renderPage() { return render(<MantineProvider><MemoryRouter initialEntries={["/live-operations"]}><LiveOperationsPage /></MemoryRouter></MantineProvider>); }
describe("Live Operations page", () => {
  it("renders the all-Live overview without trading or authorization controls", () => { mocks.scope = { selectedAccount: null, isAll: true }; mocks.data = response(); renderPage(); expect(screen.getByText("Live accounts")).toBeTruthy(); expect(screen.getByText("Bobby Live")).toBeTruthy(); expect(screen.queryByRole("button", { name: /grant|arm|close|cancel/i })).toBeNull(); });
  it.each(["HEALTHY", "DEGRADED", "UNKNOWN", "ACTION_REQUIRED"] as const)("renders %s account health", (health) => { mocks.scope = { selectedAccount: null, isAll: true }; mocks.data = { ...response(), accounts: [{ ...snapshot, health }] as LiveOperationsResponse["accounts"] }; renderPage(); expect(screen.getAllByText(health.replaceAll("_", " ")).length).toBeGreaterThan(0); });
  it("renders single-account safety semantics and responsive position layout", () => { mocks.scope = { selectedAccount: { id: 7, environment: "LIVE" }, isAll: false }; mocks.data = response(); renderPage(); expect(screen.getByText("Account safety posture")).toBeTruthy(); expect(screen.getByText(/Exclusive Live-writer ownership is not proven/)).toBeTruthy(); expect(screen.getByText("Position-management capability")).toBeTruthy(); });
});

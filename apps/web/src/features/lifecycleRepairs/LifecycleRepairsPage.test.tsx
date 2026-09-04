// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LifecycleRepairCase } from "./api";

vi.mock("../../lib/api", () => ({ getAdminToken: () => "token" }));
vi.mock("../tradingAccounts/hooks", () => ({ useTradingAccounts: () => ({ data: { accounts: [] } }) }));
vi.mock("./hooks", () => ({
  useLifecycleRepairs: () => ({ data: { cases: [] }, refetch: vi.fn() }),
  useDiagnoseLifecycleRepair: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useApplyLifecycleRepair: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  usePreviewHistoricalEntryLifecycle: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useDecideLifecycleRepairAction: () => ({ mutate: vi.fn(), isError: false }),
  useApplyLifecycleRepairAction: () => ({ mutate: vi.fn(), isError: false }),
  useReconsiderLifecycleRepairAction: () => ({ mutate: vi.fn(), isError: false }),
}));

import { CaseListItem, LifecycleRepairsPage } from "./LifecycleRepairsPage";
import { lifecycleRepairCaseLabels } from "./caseLabels";
import { lifecycleRepairCaseState } from "./lifecycleRepairView";

afterEach(cleanup);

describe("Lifecycle Repairs attention workflow", () => {
  it("hides the unrelated position diagnosis form for an attention-driven workflow", () => {
    render(<MantineProvider><MemoryRouter initialEntries={["/system/lifecycle-repairs?account=7&attention=4"]}><LifecycleRepairsPage /></MemoryRouter></MantineProvider>);
    expect(screen.getByText("Historical lifecycle attention")).toBeTruthy();
    expect(screen.queryByText("Diagnose a position")).toBeNull();
    expect(screen.queryByLabelText("TrackedPosition ID")).toBeNull();
  });

  it("uses repair-type-aware case identities", () => {
    const common = { id: 3, targetId: "91", beforeJson: { symbol: "OLD" }, evidenceJson: { lifecycle: { brokerOrder: { symbol: "ZXQ" } } } } as unknown as LifecycleRepairCase;
    expect(lifecycleRepairCaseLabels({ ...common, repairType: "REPAIR_HISTORICAL_ENTRY_LIFECYCLE" })).toEqual({ identity: "Case 3 · ZXQ BUY BrokerOrder #91", description: "Historical entry lifecycle repair" });
    expect(lifecycleRepairCaseLabels({ ...common, repairType: "RESOLVE_POSITION_ATTRIBUTION" })).toEqual({ identity: "Case 3 · OLD #91", description: "Resolve position attribution" });
  });

  it("does not present a partially applied historical case as globally succeeded", () => {
    const item = { repairType: "REPAIR_HISTORICAL_ENTRY_LIFECYCLE", expired: false, superseded: false, executed: true, executable: false, evidenceJson: { unresolvedComponents: ["STALE_ORDER_STATUS", "MISSING_POSITION_LINK"] }, actions: [{ actionType: "TERMINALIZE_ORDER_LIFECYCLE", status: "APPLIED" }, { actionType: "LINK_ENTRY_LIFECYCLE_TO_POSITION", status: "SUPERSEDED" }] } as unknown as LifecycleRepairCase;
    expect(lifecycleRepairCaseState(item).label).toBe("Verification pending · link unresolved");
    render(<MantineProvider><CaseListItem item={{ ...item, id: 8, targetId: "91", confidence: "DETERMINISTIC", createdAt: "2026-09-04T10:00:00Z", expiresAt: "2026-09-04T10:10:00Z", tradingAccount: { id: 1, displayName: "Synthetic Paper", environment: "PAPER" }, beforeJson: {}, executions: [{ id: 1, result: "SUCCEEDED", executedAt: "2026-09-04T10:05:00Z" }] } as LifecycleRepairCase} selected={false} onSelect={vi.fn()} /></MantineProvider>);
    expect(screen.getByText("Verification pending · link unresolved")).toBeTruthy();
    expect(screen.queryByText("Executed")).toBeNull();
    expect(screen.queryByText("SUCCEEDED")).toBeNull();
  });

  it("presents historical completion only after authoritative verification", () => {
    const pending = { repairType: "REPAIR_HISTORICAL_ENTRY_LIFECYCLE", expired: false, superseded: false, executed: true, executable: false, evidenceJson: { unresolvedComponents: ["MISSING_POSITION_LINK"] }, actions: [{ actionType: "LINK_ENTRY_LIFECYCLE_TO_POSITION", status: "APPLIED" }] } as unknown as LifecycleRepairCase;
    expect(lifecycleRepairCaseState(pending).label).toBe("Verification pending · link unresolved");
    expect(lifecycleRepairCaseState({ ...pending, actions: [{ ...pending.actions![0]!, status: "VERIFIED" }] } as LifecycleRepairCase).label).toBe("Verified");
  });
});

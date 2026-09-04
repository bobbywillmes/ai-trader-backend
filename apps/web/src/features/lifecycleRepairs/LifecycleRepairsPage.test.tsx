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

import { LifecycleRepairsPage } from "./LifecycleRepairsPage";
import { lifecycleRepairCaseLabels } from "./caseLabels";

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
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLifecycleRepair } from "./api";

describe("Lifecycle Repair Apply API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses caseId only in the URL and sends the strict backend-compatible body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      case: {}, execution: {}, idempotent: false,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await applyLifecycleRepair("owner-token", {
      caseId: 73,
      reason: "Recover deterministic TAS ownership.",
      confirmation: "APPLY POSITION ATTRIBUTION REPAIR",
      attemptKey: "repair:73:attempt:1",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/lifecycle-repairs/73/apply");
    expect(JSON.parse(String(options.body))).toEqual({
      reason: "Recover deterministic TAS ownership.",
      confirmation: "APPLY POSITION ATTRIBUTION REPAIR",
      attemptKey: "repair:73:attempt:1",
    });
    expect(JSON.parse(String(options.body))).not.toHaveProperty("caseId");
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { source } from "./fixtures.test-support";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });
describe("external signal API contract", () => {
  it.each(["", "https://api.example.test", "/backend"])("constructs credential URLs with the configured API base %s", async base => {
    vi.stubEnv("VITE_API_BASE_URL", base); vi.resetModules();
    const { webhookUrl } = await import("./api");
    expect(webhookUrl("safe-token")).toBe(new URL(`${base}/api/external-signals/safe-token`, window.location.origin).href);
    expect(webhookUrl("safe-token")).not.toContain("?");
  });
  it("loads every source catalog page without silently truncating selectors", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sources: [source], pagination: { page: 1, pageSize: 100, total: 101, totalPages: 2 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sources: [{ ...source, id: 101 }], pagination: { page: 2, pageSize: 100, total: 101, totalPages: 2 } })));
    vi.stubGlobal("fetch", fetchMock);
    const { getSourceCatalog } = await import("./api");
    expect((await getSourceCatalog("owner-session")).map(item => item.id)).toEqual([1, 101]);
    expect(fetchMock.mock.calls[1][0]).toContain("page=2&pageSize=100");
  });
  it("sends binding updates containing only prospective fields and no identity changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", fetchMock);
    const { updateBinding } = await import("./api");
    await updateBinding(2, { enabled: false }, "owner-session");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: false });
    expect(fetchMock.mock.calls[0][0]).toContain("/external-signal-admin/bindings/2");
  });
});

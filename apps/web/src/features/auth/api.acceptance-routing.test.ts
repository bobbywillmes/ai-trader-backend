// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("acceptance browser API routing", () => {
  it("keeps login, session refresh, evidence reads, and logout on relative /api paths", async () => {
    (window as typeof window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
      "http://127.0.0.1:5174/",
    );
    vi.stubEnv("MODE", "acceptance");
    vi.stubEnv("VITE_API_BASE_URL", "");
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchMock);

    const [{ login, getMe, logout }, { apiRequest }] = await Promise.all([
      import("./api"),
      import("../../lib/api"),
    ]);
    await login("owner@example.invalid", "local-password");
    await getMe("owner-token");
    await apiRequest("/api/order-intents/1/operational-evidence", {
      token: "owner-token",
    });
    await logout("owner-token");

    expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
      "/api/auth/login",
      "/api/auth/me",
      "/api/order-intents/1/operational-evidence",
      "/api/auth/logout",
    ]);
  });
});

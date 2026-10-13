import { describe, expect, it } from "vitest";
import { assertAcceptanceApiRouting, resolveApiBaseUrl } from "./api-routing";

describe("API environment resolution", () => {
  it("preserves the ordinary development API base", () => {
    expect(resolveApiBaseUrl("development", " http://localhost:3000 ")).toBe(
      "http://localhost:3000",
    );
  });

  it("uses relative requests in acceptance mode", () => {
    const baseUrl = resolveApiBaseUrl("acceptance", "");
    expect(baseUrl).toBe("");
    expect(() =>
      assertAcceptanceApiRouting("acceptance", baseUrl, "http://127.0.0.1:5174"),
    ).not.toThrow();
  });

  it.each([
    "http://localhost:3000",
    "https://trader.example.com",
    "http://127.0.0.1:3304",
  ])("rejects acceptance API base %s", baseUrl => {
    expect(() => resolveApiBaseUrl("acceptance", baseUrl)).toThrow(
      "requires an empty VITE_API_BASE_URL",
    );
  });

  it.each([
    "http://localhost:3000",
    "https://127.0.0.1:5174",
    "https://trader.example.com",
  ])("rejects acceptance browser origin %s", origin => {
    expect(() => assertAcceptanceApiRouting("acceptance", "", origin)).toThrow(
      "Acceptance frontend origin rejected",
    );
  });
});

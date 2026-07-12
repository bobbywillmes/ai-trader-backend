import { describe, expect, it } from "vitest";
import { getAuthenticatedHomePath, isAccountPortalRole } from "./roleUtils";
import type { AccessMetadata, PlatformRole } from "./types";

function access(platformRole: PlatformRole): AccessMetadata {
  return { platformRole, permissions: [], accessibleTradingAccountIds: platformRole === "SYSTEM_OWNER" ? null : [] };
}

describe("application surface routing", () => {
  it.each([
    ["SYSTEM_OWNER", "/dashboard"],
    ["OPERATOR", "/dashboard"],
    ["ACCOUNT_USER", "/portal"],
  ] as const)("routes %s to %s", (platformRole, path) => {
    expect(getAuthenticatedHomePath(access(platformRole))).toBe(path);
  });

  it("treats only Account Users as Account Portal users", () => {
    expect(isAccountPortalRole("ACCOUNT_USER")).toBe(true);
    expect(isAccountPortalRole("OPERATOR")).toBe(false);
    expect(isAccountPortalRole("SYSTEM_OWNER")).toBe(false);
  });
});

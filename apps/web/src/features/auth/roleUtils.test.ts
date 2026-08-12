import { describe, expect, it } from "vitest";
import { getAuthenticatedHomePath } from "./roleUtils";
import type { AccessMetadata, PlatformRole } from "./types";

function access(platformRole: PlatformRole): AccessMetadata {
  return { platformRole, permissions: [], accessibleTradingAccountIds: platformRole === "SYSTEM_OWNER" ? null : [] };
}

describe("application surface routing", () => {
  it.each([
    ["SYSTEM_OWNER", "/dashboard"],
    ["OPERATOR", "/dashboard"],
    ["ACCOUNT_USER", "/dashboard"],
  ] as const)("routes %s to %s", (platformRole, path) => {
    expect(getAuthenticatedHomePath(access(platformRole))).toBe(path);
  });
});

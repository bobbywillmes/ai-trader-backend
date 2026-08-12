import type { AccessMetadata, PlatformRole } from "./types";

export function isAccountPortalRole(role: PlatformRole | null | undefined) {
  return role === "ACCOUNT_USER";
}

export function getAuthenticatedHomePath(
  access: AccessMetadata | null | undefined
) {
  return access ? "/dashboard" : "/login";
}

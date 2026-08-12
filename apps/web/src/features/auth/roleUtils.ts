import type { AccessMetadata } from "./types";

export function getAuthenticatedHomePath(
  access: AccessMetadata | null | undefined
) {
  return access ? "/dashboard" : "/login";
}

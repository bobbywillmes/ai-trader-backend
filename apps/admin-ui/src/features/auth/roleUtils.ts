import type { AdminAccess } from "./types";

export function isAccountViewerRole(role: string | null | undefined) {
  return role === "account_viewer";
}

export function getAuthenticatedHomePath(
  access: AdminAccess | null | undefined
) {
  return isAccountViewerRole(access?.role) ? "/portal" : "/dashboard";
}

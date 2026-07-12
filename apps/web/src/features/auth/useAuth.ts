import { useContext } from "react";
import { AuthContext } from "./context";
import { type PlatformPermission, type PlatformRole } from "./types";

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function useCurrentUser() {
  const { user, access } = useAuth();
  return { user, access };
}

export function usePermissions() {
  const { access } = useAuth();
  if (!access) {
    return [];
  }
  return access.permissions;
}

export function useHasPermission(permission: PlatformPermission): boolean {
  const permissions = usePermissions();
  return permissions.includes(permission);
}

export function useIsSystemOwner(): boolean {
  const { access } = useAuth();
  return access?.platformRole === ("SYSTEM_OWNER" satisfies PlatformRole);
}

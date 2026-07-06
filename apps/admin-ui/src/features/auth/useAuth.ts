import { useContext } from "react";
import { AuthContext } from "./context";

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

export function useCurrentUser() {
  const { adminUser, access } = useAuth();
  return { user: adminUser, access };
}

export function usePermissions() {
  const { access } = useAuth();
  if (!access) {
    return [];
  }
  return access.permissions;
}

export function useHasPermission(permission: string): boolean {
  const permissions = usePermissions();
  return permissions.includes(permission);
}

export function useIsOwner(): boolean {
  const { access } = useAuth();
  return access?.role === "owner" || false;
}

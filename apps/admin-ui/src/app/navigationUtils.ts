import type { AdminNavGroup, AdminNavItem } from "./navigation";

/**
 * Filter navigation groups and items based on user role and permissions.
 * System Owners see everything; other roles see permitted items.
 */
export function filterNavigationGroups(
  groups: AdminNavGroup[],
  userRole: string | undefined,
  permissions: string[] | undefined
): AdminNavGroup[] {
  const isSystemOwner = userRole === "SYSTEM_OWNER";
  const permissionSet = new Set(permissions || []);

  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        canAccessNavItem(item, isSystemOwner, permissionSet)
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Check if a user can access a specific navigation item.
 */
export function canAccessNavItem(
  item: AdminNavItem,
  isSystemOwner: boolean,
  permissions: Set<string>
): boolean {
  if (isSystemOwner) {
    return true;
  }

  if (item.systemOwnerOnly) {
    return false;
  }

  // If item requires a permission and user doesn't have it, deny access
  if (item.requiredPermission && !permissions.has(item.requiredPermission)) {
    return false;
  }

  return true;
}

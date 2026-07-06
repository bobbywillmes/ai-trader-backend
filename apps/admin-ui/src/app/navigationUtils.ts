import type { AdminNavGroup, AdminNavItem } from "./navigation";

/**
 * Filter navigation groups and items based on user role and permissions.
 * Owner role sees everything; other roles see items they have permission for.
 */
export function filterNavigationGroups(
  groups: AdminNavGroup[],
  userRole: string | undefined,
  permissions: string[] | undefined
): AdminNavGroup[] {
  const isOwner = userRole === "owner";
  const permissionSet = new Set(permissions || []);

  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        canAccessNavItem(item, isOwner, permissionSet)
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * Check if a user can access a specific navigation item.
 */
export function canAccessNavItem(
  item: AdminNavItem,
  isOwner: boolean,
  permissions: Set<string>
): boolean {
  // Owner has access to all items
  if (isOwner) {
    return true;
  }

  // If item is owner-only, non-owners cannot access
  if (item.ownerOnly) {
    return false;
  }

  // If item requires a permission and user doesn't have it, deny access
  if (item.requiredPermission && !permissions.has(item.requiredPermission)) {
    return false;
  }

  return true;
}

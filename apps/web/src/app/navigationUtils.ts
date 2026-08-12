import type { AdminNavGroup, AdminNavItem } from "./navigation";
import type { PlatformPermission, PlatformRole } from "../features/auth/types";
import { canAccessRoute } from "./routeAccess";

export function createScopedNavigationTarget(to: string, currentSearch: string): string {
  const account = new URLSearchParams(currentSearch).get("account");
  if (!account) return to;
  const [pathAndSearch, hash = ""] = to.split("#", 2);
  const [pathname, targetSearch = ""] = pathAndSearch.split("?", 2);
  const params = new URLSearchParams(targetSearch);
  params.set("account", account);
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}

function filterItem(item: AdminNavItem, role: PlatformRole, permissions: PlatformPermission[]): AdminNavItem | null {
  if (item.routeId && !canAccessRoute(item.routeId, role, permissions)) return null;
  const children = item.children?.map((child) => filterItem(child, role, permissions)).filter((child): child is AdminNavItem => child !== null);
  if (item.children && !children?.length) return null;
  return { ...item, label: item.labelByRole?.[role] ?? item.label, children };
}

export function filterNavigationGroups(
  groups: AdminNavGroup[],
  role: PlatformRole | undefined,
  permissions: PlatformPermission[] | undefined,
): AdminNavGroup[] {
  if (!role || !permissions) return [];
  return groups.map((group) => ({
    ...group,
    label: group.labelByRole?.[role] ?? group.label,
    items: group.items.map((item) => filterItem(item, role, permissions)).filter((item): item is AdminNavItem => item !== null),
  })).filter((group) => group.items.length > 0);
}

export function canAccessNavItem(item: AdminNavItem, role: PlatformRole, permissions: PlatformPermission[]): boolean {
  return filterItem(item, role, permissions) !== null;
}

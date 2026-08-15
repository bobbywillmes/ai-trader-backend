import type { PlatformPermission, PlatformRole } from "../features/auth/types";

export type AppRouteId =
  | "dashboard"
  | "positions"
  | "orders"
  | "entryDecisions"
  | "strategies"
  | "subscriptions"
  | "exitProfiles"
  | "lifecycleExercises"
  | "lifecycleRepairs"
  | "momentumScanner"
  | "marketDiary"
  | "reports"
  | "tradeHistory"
  | "tradingAccounts"
  | "reconciliation"
  | "systemEvents"
  | "users"
  | "securities"
  | "settings";

type RouteAccessPolicy = {
  allowedRoles: PlatformRole[];
  requiredPermission?: PlatformPermission;
};

const ALL_ROLES: PlatformRole[] = ["SYSTEM_OWNER", "OPERATOR", "ACCOUNT_USER"];
const OPERATIONAL_ROLES: PlatformRole[] = ["SYSTEM_OWNER", "OPERATOR"];
const OWNER_ONLY: PlatformRole[] = ["SYSTEM_OWNER"];

export const routeAccessPolicies: Record<AppRouteId, RouteAccessPolicy> = {
  dashboard: { allowedRoles: ALL_ROLES, requiredPermission: "reports.read" },
  positions: { allowedRoles: ALL_ROLES, requiredPermission: "tradingAccount.read" },
  orders: { allowedRoles: ALL_ROLES, requiredPermission: "tradingAccount.read" },
  entryDecisions: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "tradingAccount.read" },
  strategies: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "strategy.read" },
  subscriptions: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "subscription.read" },
  exitProfiles: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "exitProfile.read" },
  lifecycleExercises: { allowedRoles: OWNER_ONLY, requiredPermission: "tradingLifecycleExercise.read" },
  lifecycleRepairs: { allowedRoles: OWNER_ONLY, requiredPermission: "system.security.read" },
  momentumScanner: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "strategy.read" },
  marketDiary: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "systemEvents.read" },
  reports: { allowedRoles: ALL_ROLES, requiredPermission: "reports.read" },
  tradeHistory: { allowedRoles: ALL_ROLES, requiredPermission: "reports.read" },
  tradingAccounts: { allowedRoles: ALL_ROLES, requiredPermission: "tradingAccount.read" },
  reconciliation: { allowedRoles: OWNER_ONLY, requiredPermission: "system.security.read" },
  systemEvents: { allowedRoles: OPERATIONAL_ROLES, requiredPermission: "systemEvents.read" },
  users: { allowedRoles: OWNER_ONLY, requiredPermission: "system.settings.read" },
  securities: { allowedRoles: OWNER_ONLY, requiredPermission: "system.security.read" },
  settings: { allowedRoles: OWNER_ONLY, requiredPermission: "system.settings.read" },
};

export function canAccessRoute(
  routeId: AppRouteId,
  role: PlatformRole | undefined,
  permissions: PlatformPermission[] | undefined,
) {
  if (!role) return false;
  const policy = routeAccessPolicies[routeId];
  return policy.allowedRoles.includes(role) &&
    (!policy.requiredPermission || permissions?.includes(policy.requiredPermission) === true);
}

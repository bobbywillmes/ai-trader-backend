import { Center, Loader } from "@mantine/core";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { adminNavGroups, createPortalNavGroups } from "../app/navigation";
import { filterNavigationGroups } from "../app/navigationUtils";
import { ResponsiveAppShell } from "../components/navigation/ResponsiveAppShell";
import { AuthProvider } from "../features/auth/AuthContext";
import { useLogout, useMe } from "../features/auth/hooks";
import { isAccountPortalRole } from "../features/auth/roleUtils";
import { useAuth } from "../features/auth/useAuth";
import type { PlatformPermission } from "../features/auth/types";
import type { AppRouteId } from "../app/routeAccess";
import { canAccessRoute } from "../app/routeAccess";
import { AccessDeniedPage } from "../pages/AccessDeniedPage";
import { getAdminToken } from "../lib/api";
import type { ReactNode } from "react";
import { TradingAccountScopeProvider } from "../features/tradingAccountScope/TradingAccountScopeProvider";
import { getPageScope } from "../app/pageScope";

export function AdminLayout() {
  const token = getAdminToken();
  const { isLoading, isError, data } = useMe(token);
  if (!token) return <Navigate to="/login" replace />;
  if (isLoading) return <Center h="100vh"><Loader color="cyan" /></Center>;
  if (isError || !data) return <Navigate to="/login" replace />;
  return <AuthProvider user={data.user} access={data.access} isLoading={isLoading}><Outlet /></AuthProvider>;
}

export function AdminConsoleGuard() {
  return <Outlet />;
}

export function AccountPortalGuard() {
  const { access } = useAuth();
  return !isAccountPortalRole(access?.platformRole) ? <Navigate to="/dashboard" replace /> : <Outlet />;
}

export function PermissionGuard({ permission, children }: { permission: PlatformPermission; children: ReactNode }) {
  const { access } = useAuth();
  return access?.permissions.includes(permission) ? children : <Navigate to="/dashboard" replace />;
}

export function RouteAccessGuard({ routeId, children }: { routeId: AppRouteId; children: ReactNode }) {
  const { access } = useAuth();
  return canAccessRoute(routeId, access?.platformRole, access?.permissions) ? children : <AccessDeniedPage />;
}

function AuthenticatedShell({ portal = false }: { portal?: boolean }) {
  const { user, access } = useAuth();
  const logoutMutation = useLogout(getAdminToken());
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const routeAccountId = pathname.match(/^\/portal\/accounts\/(\d+)/)?.[1] ?? null;
  const assigned = access?.accessibleTradingAccountIds ?? [];
  const activeAccountId = routeAccountId ?? (assigned.length === 1 ? String(assigned[0]) : null);
  const groups = portal
    ? createPortalNavGroups(activeAccountId ? `/portal/accounts/${activeAccountId}` : null)
    : filterNavigationGroups(adminNavGroups, access?.platformRole, access?.permissions);

  async function handleLogout() {
    await logoutMutation.mutateAsync();
    navigate("/login", { replace: true });
  }

  const pageScope = getPageScope(pathname);
  const shell = <ResponsiveAppShell
    groups={groups}
    user={user}
    platformRole={access?.platformRole}
    portalName={portal ? "Account Portal" : "Admin Console"}
    isSigningOut={logoutMutation.isPending}
    onSignOut={handleLogout}
    pageScope={portal ? undefined : pageScope}
    preserveTradingAccountScope={!portal}
  ><Outlet /></ResponsiveAppShell>;
  return portal ? shell : <TradingAccountScopeProvider>{shell}</TradingAccountScopeProvider>;
}

export function AdminConsoleShell() { return <AuthenticatedShell />; }
export function AccountPortalShell() { return <AuthenticatedShell portal />; }

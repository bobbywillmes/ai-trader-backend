import { Center, Loader } from "@mantine/core";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { adminNavGroups } from "../app/navigation";
import { filterNavigationGroups } from "../app/navigationUtils";
import { ResponsiveAppShell } from "../components/navigation/ResponsiveAppShell";
import { AuthProvider } from "../features/auth/AuthContext";
import { useLogout, useMe } from "../features/auth/hooks";
import { useAuth } from "../features/auth/useAuth";
import type { PlatformPermission } from "../features/auth/types";
import type { AppRouteId } from "../app/routeAccess";
import { canAccessRoute } from "../app/routeAccess";
import { AccessDeniedPage } from "../pages/AccessDeniedPage";
import { getAdminToken } from "../lib/api";
import type { ReactNode } from "react";
import { TradingAccountScopeProvider } from "../features/tradingAccountScope/TradingAccountScopeProvider";
import { getPageScope } from "../app/pageScope";
import { useAttentionSummary } from "../features/operationalAttention/hooks";

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

export function PermissionGuard({ permission, children }: { permission: PlatformPermission; children: ReactNode }) {
  const { access } = useAuth();
  return access?.permissions.includes(permission) ? children : <Navigate to="/dashboard" replace />;
}

export function RouteAccessGuard({ routeId, children }: { routeId: AppRouteId; children: ReactNode }) {
  const { access } = useAuth();
  return canAccessRoute(routeId, access?.platformRole, access?.permissions) ? children : <AccessDeniedPage />;
}

function AuthenticatedShell() {
  const { user, access } = useAuth();
  const logoutMutation = useLogout(getAdminToken());
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const attentionVisible = access?.permissions.includes("operationalAttention.read") === true;
  const attention = useAttentionSummary(getAdminToken(), "all", attentionVisible);
  const groups = filterNavigationGroups(adminNavGroups, access?.platformRole, access?.permissions).map((group) => ({ ...group, items: group.items.map((item) => item.routeId === "operationalAttention" && attention.data?.totalUnresolved ? { ...item, badge: { count: attention.data.totalUnresolved, color: attention.data.highestSeverity === "CRITICAL" ? "red" : attention.data.highestSeverity === "ERROR" ? "orange" : "yellow", label: `${attention.data.totalUnresolved} unresolved operational attention` } } : item) }));

  async function handleLogout() {
    await logoutMutation.mutateAsync();
    navigate("/login", { replace: true });
  }

  const pageScope = getPageScope(pathname);
  return (
    <TradingAccountScopeProvider>
      <ResponsiveAppShell
        groups={groups}
        user={user}
        platformRole={access?.platformRole}
        isSigningOut={logoutMutation.isPending}
        onSignOut={handleLogout}
        pageScope={pageScope}
        preserveTradingAccountScope
      >
        <Outlet />
      </ResponsiveAppShell>
    </TradingAccountScopeProvider>
  );
}

export function AdminConsoleShell() { return <AuthenticatedShell />; }

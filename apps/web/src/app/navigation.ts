import type { ComponentType } from "react";
import type { IconProps } from "@tabler/icons-react";
import {
  IconActivity, IconAdjustments, IconBuildingBank, IconChartBar,
  IconChartCandle, IconClipboardData, IconDashboard, IconFileAnalytics,
  IconFlask, IconHistory, IconListCheck, IconReportAnalytics, IconRoute, IconTool,
  IconSettings, IconShieldCheck, IconTargetArrow, IconUsers,
  IconHeartbeat,
} from "@tabler/icons-react";
import type { PlatformRole } from "../features/auth/types";
import type { AppRouteId } from "./routeAccess";

export type NavigationIcon = ComponentType<IconProps>;
export type ActiveRouteMatcher = (pathname: string) => boolean;

export type AdminNavItem = {
  routeId?: AppRouteId;
  to?: string;
  label: string;
  labelByRole?: Partial<Record<PlatformRole, string>>;
  icon: NavigationIcon;
  isActive?: ActiveRouteMatcher;
  children?: AdminNavItem[];
};

export type AdminNavGroup = {
  label: string;
  labelByRole?: Partial<Record<PlatformRole, string>>;
  items: AdminNavItem[];
};

export function matchesRoute(to: string): ActiveRouteMatcher {
  return (pathname) => pathname === to || pathname.startsWith(`${to}/`);
}

export const matchesTradingAccountsRoute: ActiveRouteMatcher = (pathname) =>
  (pathname === "/trading-accounts" || /^\/trading-accounts\/\d+\/?$/.test(pathname)) &&
  !/^\/trading-accounts\/\d+\/reconciliation\/?$/.test(pathname);

export function isNavigationItemActive(item: AdminNavItem, pathname: string): boolean {
  if (item.children?.some((child) => isNavigationItemActive(child, pathname))) return true;
  if (!item.to) return false;
  return (item.isActive ?? matchesRoute(item.to))(pathname);
}

export const adminNavGroups: AdminNavGroup[] = [
  { label: "Dashboard", items: [
    { routeId: "dashboard", to: "/dashboard", label: "Dashboard", icon: IconDashboard },
  ] },
  { label: "Trading", items: [
    { routeId: "liveOperations", to: "/live-operations", label: "Live Operations", icon: IconHeartbeat },
    { routeId: "positions", to: "/positions/open", label: "Open Positions", icon: IconChartCandle },
    { routeId: "orders", to: "/orders/open", label: "Open Orders", icon: IconListCheck },
    { routeId: "entryDecisions", to: "/entry-decisions", label: "Entry Decisions", icon: IconTargetArrow },
  ] },
  { label: "Market Intelligence", items: [
    { routeId: "momentumScanner", to: "/momentum-scanner", label: "Momentum Scanner", icon: IconActivity },
    { routeId: "marketDiary", to: "/market-diary", label: "Market Diary", icon: IconChartBar },
  ] },
  { label: "Reports", items: [
    { routeId: "reports", to: "/reports", label: "Reports", icon: IconReportAnalytics },
    { routeId: "tradeHistory", to: "/trade-history", label: "Trade History", icon: IconHistory },
  ] },
  { label: "System", labelByRole: { ACCOUNT_USER: "Accounts" }, items: [
    { routeId: "tradingAccounts", to: "/trading-accounts", label: "Trading Accounts", labelByRole: { ACCOUNT_USER: "My Accounts" }, icon: IconBuildingBank, isActive: matchesTradingAccountsRoute },
    { routeId: "reconciliation", to: "/system/reconciliation", label: "Reconciliation", icon: IconAdjustments, isActive: (path) => path === "/system/reconciliation" || path.startsWith("/system/reconciliation/") || /^\/trading-accounts\/\d+\/reconciliation\/?$/.test(path) },
    { routeId: "systemEvents", to: "/system/events", label: "System Events", icon: IconActivity },
    { routeId: "lifecycleExercises", to: "/lifecycle-exercises", label: "Lifecycle Exercises", icon: IconFlask },
    { routeId: "lifecycleRepairs", to: "/system/lifecycle-repairs", label: "Lifecycle Repairs", icon: IconTool },
  ] },
  { label: "Administration", items: [
    { label: "Trading Setup", icon: IconRoute, children: [
      { routeId: "strategies", to: "/strategies", label: "Strategies", icon: IconRoute },
      { routeId: "subscriptions", to: "/subscriptions", label: "Subscriptions", icon: IconClipboardData },
      { routeId: "exitProfiles", to: "/exit-profiles", label: "Exit Profiles", icon: IconShieldCheck },
    ] },
    { routeId: "users", to: "/users", label: "Users & Access", icon: IconUsers },
    { routeId: "securities", to: "/securities", label: "Securities", icon: IconFileAnalytics },
    { routeId: "settings", to: "/settings", label: "Settings", icon: IconSettings },
  ] },
];

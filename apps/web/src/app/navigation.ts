import type { ComponentType } from "react";
import type { IconProps } from "@tabler/icons-react";
import {
  IconActivity, IconAdjustments, IconBuildingBank, IconChartBar,
  IconChartCandle, IconClipboardData, IconDashboard, IconFileAnalytics,
  IconFlask, IconHistory, IconListCheck, IconReportAnalytics, IconRoute,
  IconSettings, IconShieldCheck, IconTargetArrow, IconUsers,
} from "@tabler/icons-react";
import type { PlatformPermission } from "../features/auth/types";

export type NavigationIcon = ComponentType<IconProps>;
export type ActiveRouteMatcher = (pathname: string) => boolean;

export type AdminNavItem = {
  to: string;
  label: string;
  icon: NavigationIcon;
  isActive?: ActiveRouteMatcher;
  systemOwnerOnly?: boolean;
  requiredPermission?: PlatformPermission;
};

export type AdminNavGroup = { label: string; items: AdminNavItem[] };

export function matchesRoute(to: string): ActiveRouteMatcher {
  return (pathname) => pathname === to || pathname.startsWith(`${to}/`);
}

export function isNavigationItemActive(item: AdminNavItem, pathname: string) {
  return (item.isActive ?? matchesRoute(item.to))(pathname);
}

export const adminNavGroups: AdminNavGroup[] = [
  { label: "Dashboard", items: [{ to: "/dashboard", label: "Dashboard", icon: IconDashboard, requiredPermission: "reports.read" }] },
  { label: "Live Data", items: [
    { to: "/positions/open", label: "Open Positions", icon: IconChartCandle, requiredPermission: "tradingAccount.read" },
    { to: "/orders/open", label: "Open Orders", icon: IconListCheck, requiredPermission: "tradingAccount.read" },
  ] },
  { label: "Trading", items: [
    { to: "/trading-accounts", label: "Trading Accounts", icon: IconBuildingBank, requiredPermission: "tradingAccount.read" },
    { to: "/entry-decisions", label: "Entry Decisions", icon: IconTargetArrow, requiredPermission: "tradingAccount.read" },
    { to: "/lifecycle-exercises", label: "Lifecycle Exercises", icon: IconFlask, systemOwnerOnly: true, requiredPermission: "tradingLifecycleExercise.read" },
    { to: "/momentum-scanner", label: "Momentum Scanner", icon: IconActivity, requiredPermission: "strategy.read" },
    { to: "/strategies", label: "Strategies", icon: IconRoute, requiredPermission: "strategy.read" },
    { to: "/subscriptions", label: "Subscriptions", icon: IconClipboardData, requiredPermission: "subscription.read" },
  ] },
  { label: "Risk & Safety", items: [
    { to: "/exit-profiles", label: "Exit Profiles", icon: IconShieldCheck, requiredPermission: "exitProfile.read" },
    { to: "/system/reconciliation", label: "Reconciliation", icon: IconAdjustments, requiredPermission: "system.security.read" },
  ] },
  { label: "Market Intelligence", items: [
    { to: "/market-diary", label: "Market Diary", icon: IconChartBar, requiredPermission: "systemEvents.read" },
    { to: "/system/events", label: "System Events", icon: IconActivity, requiredPermission: "systemEvents.read" },
  ] },
  { label: "Reports", items: [
    { to: "/reports", label: "Reports", icon: IconReportAnalytics, requiredPermission: "reports.read" },
    { to: "/trade-history", label: "Trade History", icon: IconHistory, requiredPermission: "reports.read" },
  ] },
  { label: "Administration", items: [
    { to: "/users", label: "Users & Access", icon: IconUsers, systemOwnerOnly: true },
    { to: "/securities", label: "Securities", icon: IconFileAnalytics, requiredPermission: "system.security.read" },
    { to: "/settings", label: "Settings", icon: IconSettings, requiredPermission: "system.settings.read" },
  ] },
];

export function createPortalNavGroups(accountBasePath: string | null): AdminNavGroup[] {
  return [{ label: "Portal", items: [
    { to: "/portal", label: "Dashboard", icon: IconDashboard, isActive: (path) => path === "/portal" },
    { to: "/portal/accounts", label: "Accounts", icon: IconBuildingBank, isActive: (path) => path === "/portal/accounts" || /^\/portal\/accounts\/\d+$/.test(path) },
    ...(accountBasePath ? [
      { to: `${accountBasePath}/positions`, label: "Positions", icon: IconChartCandle },
      { to: `${accountBasePath}/orders`, label: "Orders", icon: IconListCheck },
      { to: `${accountBasePath}/trade-history`, label: "Trade History", icon: IconHistory },
    ] : []),
  ] }];
}

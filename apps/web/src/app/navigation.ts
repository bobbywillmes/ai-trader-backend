export type AdminNavItem = {
  to: string;
  label: string;
  systemOwnerOnly?: boolean;
  requiredPermission?: PlatformPermission;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    label: "Dashboard",
    items: [{ to: "/dashboard", label: "Dashboard", requiredPermission: "reports.read" }],
  },
  {
    label: "Live Data",
    items: [
      { to: "/positions/open", label: "Open Positions", requiredPermission: "tradingAccount.read" },
      { to: "/orders/open", label: "Open Orders", requiredPermission: "tradingAccount.read" },
    ],
  },
  {
    label: "Trading",
    items: [
      { to: "/trading-accounts", label: "Trading Accounts", requiredPermission: "tradingAccount.read" },
      { to: "/entry-decisions", label: "Entry Decisions", requiredPermission: "tradingAccount.read" },
      { to: "/momentum-scanner", label: "Momentum Scanner", requiredPermission: "strategy.read" },
      { to: "/strategies", label: "Strategies", requiredPermission: "strategy.read" },
      { to: "/subscriptions", label: "Subscriptions", requiredPermission: "subscription.read" },
    ],
  },
  {
    label: "Risk & Safety",
    items: [
      { to: "/exit-profiles", label: "Exit Profiles", requiredPermission: "exitProfile.read" },
      { to: "/system/reconciliation", label: "Reconciliation", requiredPermission: "system.security.read" },
    ],
  },
  {
    label: "Market Intelligence",
    items: [
      { to: "/market-diary", label: "Market Diary", requiredPermission: "systemEvents.read" },
      { to: "/system/events", label: "System Events", requiredPermission: "systemEvents.read" },
    ],
  },
  {
    label: "Reports",
    items: [
      { to: "/reports", label: "Reports", requiredPermission: "reports.read" },
      { to: "/trade-history", label: "Trade History", requiredPermission: "reports.read" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/users", label: "Users & Access", systemOwnerOnly: true },
      { to: "/securities", label: "Securities", requiredPermission: "system.security.read" },
      { to: "/settings", label: "Settings", requiredPermission: "system.settings.read" },
    ],
  },
];
import type { PlatformPermission } from "../features/auth/types";

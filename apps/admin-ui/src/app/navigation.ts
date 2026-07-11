export type AdminNavItem = {
  to: string;
  label: string;
  systemOwnerOnly?: boolean;
  requiredPermission?: string;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    label: "Dashboard",
    items: [{ to: "/dashboard", label: "Dashboard" }],
  },
  {
    label: "Live Data",
    items: [
      { to: "/positions/open", label: "Open Positions" },
      { to: "/orders/open", label: "Open Orders" },
    ],
  },
  {
    label: "Trading",
    items: [
      { to: "/trading-accounts", label: "Trading Accounts" },
      { to: "/entry-decisions", label: "Entry Decisions" },
      { to: "/momentum-scanner", label: "Momentum Scanner" },
      { to: "/strategies", label: "Strategies" },
      { to: "/subscriptions", label: "Subscriptions" },
    ],
  },
  {
    label: "Risk & Safety",
    items: [
      { to: "/exit-profiles", label: "Exit Profiles" },
      { to: "/system/reconciliation", label: "Reconciliation" },
    ],
  },
  {
    label: "Market Intelligence",
    items: [
      { to: "/market-diary", label: "Market Diary" },
      { to: "/system/events", label: "System Events" },
    ],
  },
  {
    label: "Reports",
    items: [
      { to: "/reports", label: "Reports" },
      { to: "/trade-history", label: "Trade History" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/users", label: "Users & Access", systemOwnerOnly: true },
      { to: "/securities", label: "Securities" },
      { to: "/settings", label: "Settings" },
    ],
  },
];

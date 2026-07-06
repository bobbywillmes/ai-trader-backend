export type AdminNavItem = {
  to: string;
  label: string;
  ownerOnly?: boolean;
  requiredPermission?: string;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
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
      { to: "/subscriptions", label: "Subscriptions" },
      { to: "/exit-profiles", label: "Exit Profiles" },
      { to: "/securities", label: "Securities" },
      { to: "/trading-accounts", label: "Trading Accounts" },
      { to: "/trade-history", label: "Trade History" },
      { to: "/entry-decisions", label: "Entry Decisions" },
      { to: "/momentum-scanner", label: "Momentum Scanner" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/reports", label: "Reports" },
      { to: "/market-diary", label: "Market Diary" },
      { to: "/system/events", label: "System Events" },
      { to: "/system/reconciliation", label: "Reconciliation" },
      { to: "/settings", label: "Settings" },
    ],
  },
];

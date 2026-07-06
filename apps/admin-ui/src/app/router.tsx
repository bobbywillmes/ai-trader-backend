import { createBrowserRouter, Navigate } from "react-router-dom";

import { AdminLayout } from "../layouts/AdminLayout";
import { HomePage } from "../pages/HomePage";
import { DashboardPage } from "../pages/DashboardPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { SubscriptionsPage } from "../features/subscriptions/SubscriptionsPage";
import { ExitProfilesPage } from "../features/exitProfiles/ExitProfilesPage";
import { PositionsPage } from "../features/positions/PositionsPage";
import { OrdersPage } from "../features/orders/OrdersPage";
import { SecuritiesPage } from "../features/securities/SecuritiesPage";
import { SystemEventsPage } from "../features/systemEvents/SystemEventsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SecurityDetailPage } from "../features/securities/SecurityDetailPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { MarketDiaryPage } from "../features/marketDiary/MarketDiaryPage"
import { ReconciliationPage } from "../features/reconciliation/ReconciliationPage";
import { TradeHistoryPage } from "../features/tradeHistory/TradeHistoryPage";
import { EntryDecisionsPage } from "../features/entryDecisions/EntryDecisionsPage";
import { TradingAccountsPage } from "../features/tradingAccounts/TradingAccountsPage";
import { TradingAccountDetailPage } from "../features/tradingAccounts/TradingAccountDetailPage";
import { MomentumScannerPage } from "../features/momentumScanner/MomentumScannerPage";
import { StrategiesPage } from "../features/strategies/StrategiesPage";
import { AdminUsersPage } from "../features/adminUsers/AdminUsersPage";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <HomePage />,
  },
  {
    path: "/",
    element: <AdminLayout />,
    children: [
      {
        index: true,
        element: <Navigate to="/dashboard" replace />,
      },
      {
        path: "dashboard",
        element: <DashboardPage />,
      },
      {
        path: "positions/open",
        element: <PositionsPage />,
      },
      {
        path: "orders/open",
        element: <OrdersPage />,
      },
      {
        path: "trade-history",
        element: <TradeHistoryPage />,
      },
      {
        path: "entry-decisions",
        element: <EntryDecisionsPage />,
      },
      {
        path: "momentum-scanner",
        element: <MomentumScannerPage />,
      },
      {
        path: "strategies",
        element: <StrategiesPage />,
      },
      {
        path: "trading-accounts",
        element: <TradingAccountsPage />,
      },
      {
        path: "trading-accounts/:id",
        element: <TradingAccountDetailPage />,
      },
      {
        path: "subscriptions",
        element: <SubscriptionsPage />,
      },
      {
        path: "exit-profiles",
        element: <ExitProfilesPage />,
      },
      {
        path: "securities",
        element: <SecuritiesPage />,
      },
      {
        path: "securities/:symbol",
        element: <SecurityDetailPage />,
      },
      {
        path: "reports",
        element: <ReportsPage />,
      },
      {
        path: "system/events",
        element: <SystemEventsPage />,
      },
      { 
        path: "system/reconciliation",
        element: <ReconciliationPage />
      },
      {
        path: "market-diary",
        element: <MarketDiaryPage />,
      },
      {
        path: "settings",
        element: <SettingsPage />,
      },
      {
        path: "admin-users",
        element: <AdminUsersPage />,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);

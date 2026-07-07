import { createBrowserRouter } from "react-router-dom";

import {
  AdminConsoleGuard,
  AdminConsoleShell,
  AdminLayout,
  ViewerPortalGuard,
  ViewerPortalShell,
} from "../layouts/AdminLayout";
import { HomePage } from "../pages/HomePage";
import { SetupAccountPage } from "../pages/SetupAccountPage";
import { DashboardPage } from "../pages/DashboardPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import { RoleHomeRedirect } from "../pages/RoleHomeRedirect";
import { SubscriptionsPage } from "../features/subscriptions/SubscriptionsPage";
import { ExitProfilesPage } from "../features/exitProfiles/ExitProfilesPage";
import { PositionsPage } from "../features/positions/PositionsPage";
import { OrdersPage } from "../features/orders/OrdersPage";
import { SecuritiesPage } from "../features/securities/SecuritiesPage";
import { SystemEventsPage } from "../features/systemEvents/SystemEventsPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SecurityDetailPage } from "../features/securities/SecurityDetailPage";
import { ReportsPage } from "../features/reports/ReportsPage";
import { MarketDiaryPage } from "../features/marketDiary/MarketDiaryPage";
import { ReconciliationPage } from "../features/reconciliation/ReconciliationPage";
import { TradeHistoryPage } from "../features/tradeHistory/TradeHistoryPage";
import { EntryDecisionsPage } from "../features/entryDecisions/EntryDecisionsPage";
import { TradingAccountsPage } from "../features/tradingAccounts/TradingAccountsPage";
import { TradingAccountDetailPage } from "../features/tradingAccounts/TradingAccountDetailPage";
import { MomentumScannerPage } from "../features/momentumScanner/MomentumScannerPage";
import { StrategiesPage } from "../features/strategies/StrategiesPage";
import { AdminUsersPage } from "../features/adminUsers/AdminUsersPage";
import { ViewerAccountPage } from "../features/viewerPortal/ViewerAccountPage";
import { ViewerPortalPage } from "../features/viewerPortal/ViewerPortalPage";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <HomePage />,
  },
  {
    path: "/setup-account",
    element: <SetupAccountPage />,
  },
  {
    path: "/",
    element: <AdminLayout />,
    children: [
      {
        index: true,
        element: <RoleHomeRedirect />,
      },
      {
        element: <AdminConsoleGuard />,
        children: [
          {
            element: <AdminConsoleShell />,
            children: [
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
                element: <ReconciliationPage />,
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
        ],
      },
      {
        element: <ViewerPortalGuard />,
        children: [
          {
            path: "portal",
            element: <ViewerPortalShell />,
            children: [
              {
                index: true,
                element: <ViewerPortalPage />,
              },
              {
                path: "accounts/:accountId",
                element: <ViewerAccountPage />,
              },
              {
                path: "accounts/:accountId/positions",
                element: <ViewerAccountPage view="positions" />,
              },
              {
                path: "accounts/:accountId/orders",
                element: <ViewerAccountPage view="orders" />,
              },
              {
                path: "accounts/:accountId/trade-history",
                element: <ViewerAccountPage view="trade-history" />,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);

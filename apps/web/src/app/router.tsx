import { createBrowserRouter } from "react-router-dom";
import type { ReactNode } from "react";

import {
  AdminConsoleGuard,
  AdminConsoleShell,
  AdminLayout,
  PermissionGuard,
  AccountPortalGuard,
  AccountPortalShell,
} from "../layouts/AdminLayout";
import type { PlatformPermission } from "../features/auth/types";

function requirePermission(permission: PlatformPermission, element: ReactNode) {
  return <PermissionGuard permission={permission}>{element}</PermissionGuard>;
}
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
import { TradingAccountDetailPage } from "../features/tradingAccounts/detail/TradingAccountDetailPage";
import { MomentumScannerPipelinePage } from "../features/momentumScanner/MomentumScannerPage";
import { MomentumUniversePage } from "../features/momentumScanner/MomentumUniversePage";
import { MomentumSymbolResearchPage } from "../features/momentumScanner/MomentumSymbolResearchPage";
import { MomentumResearchDashboardPage } from "../features/momentumScanner/MomentumResearchDashboardPage";
import { MomentumCandidatesPage } from "../features/momentumScanner/MomentumCandidatesPage";
import { MomentumCatalystsPage } from "../features/momentumScanner/MomentumCatalystsPage";
import { MomentumCandidateDetailPage } from "../features/momentumScanner/MomentumCandidateDetailPage";
import { StrategiesPage } from "../features/strategies/StrategiesPage";
import { StrategyDetailPage } from "../features/strategies/StrategyDetailPage";
import { UsersPage } from "../features/users/UsersPage";
import { AccountPage } from "../features/accountPortal/AccountPage";
import {
  AccountPortalAccountsPage,
  AccountPortalPage,
} from "../features/accountPortal/AccountPortalPage";

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
                element: requirePermission("reports.read", <DashboardPage />),
              },
              {
                path: "positions/open",
                element: requirePermission("tradingAccount.read", <PositionsPage />),
              },
              {
                path: "orders/open",
                element: requirePermission("tradingAccount.read", <OrdersPage />),
              },
              {
                path: "trade-history",
                element: requirePermission("reports.read", <TradeHistoryPage />),
              },
              {
                path: "entry-decisions",
                element: requirePermission("tradingAccount.read", <EntryDecisionsPage />),
              },
              {
                path: "momentum-scanner",
                element: requirePermission("strategy.read", <MomentumResearchDashboardPage />),
              },
              {
                path: "momentum-scanner/pipeline",
                element: requirePermission("strategy.read", <MomentumScannerPipelinePage />),
              },
              {
                path: "momentum-scanner/universe",
                element: requirePermission("strategy.read", <MomentumUniversePage />),
              },
              {
                path: "momentum-scanner/candidates",
                element: requirePermission("strategy.read", <MomentumCandidatesPage />),
              },
              {
                path: "momentum-scanner/candidates/:candidateId",
                element: requirePermission("strategy.read", <MomentumCandidateDetailPage />),
              },
              {
                path: "momentum-scanner/catalysts",
                element: requirePermission("strategy.read", <MomentumCatalystsPage />),
              },
              {
                path: "momentum-scanner/symbols/:symbol",
                element: requirePermission("strategy.read", <MomentumSymbolResearchPage />),
              },
              {
                path: "strategies",
                element: requirePermission("strategy.read", <StrategiesPage />),
              },
              {
                path: "strategies/:strategyId",
                element: requirePermission("strategy.read", <StrategyDetailPage />),
              },
              {
                path: "trading-accounts",
                element: requirePermission("tradingAccount.read", <TradingAccountsPage />),
              },
              {
                path: "trading-accounts/:id",
                element: requirePermission("tradingAccount.read", <TradingAccountDetailPage />),
              },
              {
                path: "subscriptions",
                element: requirePermission("subscription.read", <SubscriptionsPage />),
              },
              {
                path: "exit-profiles",
                element: requirePermission("exitProfile.read", <ExitProfilesPage />),
              },
              {
                path: "securities",
                element: requirePermission("system.security.read", <SecuritiesPage />),
              },
              {
                path: "securities/:symbol",
                element: requirePermission("system.security.read", <SecurityDetailPage />),
              },
              {
                path: "reports",
                element: requirePermission("reports.read", <ReportsPage />),
              },
              {
                path: "system/events",
                element: requirePermission("systemEvents.read", <SystemEventsPage />),
              },
              {
                path: "system/reconciliation",
                element: requirePermission("system.security.read", <ReconciliationPage />),
              },
              {
                path: "market-diary",
                element: requirePermission("systemEvents.read", <MarketDiaryPage />),
              },
              {
                path: "settings",
                element: requirePermission("system.settings.read", <SettingsPage />),
              },
              {
                path: "users",
                element: requirePermission("system.settings.read", <UsersPage />),
              },
            ],
          },
        ],
      },
      {
        element: <AccountPortalGuard />,
        children: [
          {
            path: "portal",
            element: <AccountPortalShell />,
            children: [
              {
                index: true,
                element: <AccountPortalPage />,
              },
              {
                path: "accounts",
                element: <AccountPortalAccountsPage />,
              },
              {
                path: "accounts/:accountId",
                element: <AccountPage />,
              },
              {
                path: "accounts/:accountId/positions",
                element: <AccountPage view="positions" />,
              },
              {
                path: "accounts/:accountId/orders",
                element: <AccountPage view="orders" />,
              },
              {
                path: "accounts/:accountId/trade-history",
                element: <AccountPage view="trade-history" />,
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

import { createBrowserRouter } from "react-router-dom";
import type { ReactNode } from "react";

import {
  AdminConsoleGuard,
  AdminConsoleShell,
  AdminLayout,
  RouteAccessGuard,
} from "../layouts/AdminLayout";
import type { AppRouteId } from "./routeAccess";

function authorize(routeId: AppRouteId, element: ReactNode) {
  return <RouteAccessGuard routeId={routeId}>{element}</RouteAccessGuard>;
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
import { ReconciliationPage, ReconciliationTargetPage } from "../features/reconciliation/ReconciliationPage";
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
import { LifecycleExercisesPage } from "../features/lifecycleExercises/LifecycleExercisesPage";
import { LifecycleExerciseDetailPage } from "../features/lifecycleExercises/LifecycleExerciseDetailPage";
import { LifecycleRepairsPage } from "../features/lifecycleRepairs/LifecycleRepairsPage";

const responsiveDataPreviewRoute = import.meta.env.DEV
  ? [{ path: "dev/responsive-data-primitives", lazy: async () => ({ Component: (await import("../features/dev/ResponsiveDataPrimitivesPreview")).ResponsiveDataPrimitivesPreview }) }]
  : [];

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
              ...responsiveDataPreviewRoute,
              {
                path: "dashboard",
                element: authorize("dashboard", <DashboardPage />),
              },
              {
                path: "positions/open",
                element: authorize("positions", <PositionsPage />),
              },
              {
                path: "orders/open",
                element: authorize("orders", <OrdersPage />),
              },
              {
                path: "trade-history",
                element: authorize("tradeHistory", <TradeHistoryPage />),
              },
              {
                path: "entry-decisions",
                element: authorize("entryDecisions", <EntryDecisionsPage />),
              },
              {
                path: "lifecycle-exercises",
                element: authorize("lifecycleExercises", <LifecycleExercisesPage />),
              },
              {
                path: "lifecycle-exercises/:id",
                element: authorize("lifecycleExercises", <LifecycleExerciseDetailPage />),
              },
              {
                path: "momentum-scanner",
                element: authorize("momentumScanner", <MomentumResearchDashboardPage />),
              },
              {
                path: "momentum-scanner/pipeline",
                element: authorize("momentumScanner", <MomentumScannerPipelinePage />),
              },
              {
                path: "momentum-scanner/universe",
                element: authorize("momentumScanner", <MomentumUniversePage />),
              },
              {
                path: "momentum-scanner/candidates",
                element: authorize("momentumScanner", <MomentumCandidatesPage />),
              },
              {
                path: "momentum-scanner/candidates/:candidateId",
                element: authorize("momentumScanner", <MomentumCandidateDetailPage />),
              },
              {
                path: "momentum-scanner/catalysts",
                element: authorize("momentumScanner", <MomentumCatalystsPage />),
              },
              {
                path: "momentum-scanner/symbols/:symbol",
                element: authorize("momentumScanner", <MomentumSymbolResearchPage />),
              },
              {
                path: "strategies",
                element: authorize("strategies", <StrategiesPage />),
              },
              {
                path: "strategies/:strategyId",
                element: authorize("strategies", <StrategyDetailPage />),
              },
              {
                path: "trading-accounts",
                element: authorize("tradingAccounts", <TradingAccountsPage />),
              },
              {
                path: "trading-accounts/:id",
                element: authorize("tradingAccounts", <TradingAccountDetailPage />),
              },
              {
                path: "trading-accounts/:id/reconciliation",
                element: authorize("reconciliation", <ReconciliationPage />),
              },
              {
                path: "subscriptions",
                element: authorize("subscriptions", <SubscriptionsPage />),
              },
              {
                path: "exit-profiles",
                element: authorize("exitProfiles", <ExitProfilesPage />),
              },
              {
                path: "securities",
                element: authorize("securities", <SecuritiesPage />),
              },
              {
                path: "securities/:symbol",
                element: authorize("securities", <SecurityDetailPage />),
              },
              {
                path: "reports",
                element: authorize("reports", <ReportsPage />),
              },
              {
                path: "reports/:reportSection",
                element: authorize("reports", <ReportsPage />),
              },
              {
                path: "system/events",
                element: authorize("systemEvents", <SystemEventsPage />),
              },
              {
                path: "system/reconciliation",
                element: authorize("reconciliation", <ReconciliationTargetPage />),
              },
              {
                path: "system/lifecycle-repairs",
                element: authorize("lifecycleRepairs", <LifecycleRepairsPage />),
              },
              {
                path: "market-diary",
                element: authorize("marketDiary", <MarketDiaryPage />),
              },
              {
                path: "settings",
                element: authorize("settings", <SettingsPage />),
              },
              {
                path: "users",
                element: authorize("users", <UsersPage />),
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

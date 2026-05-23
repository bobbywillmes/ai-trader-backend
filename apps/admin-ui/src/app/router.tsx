import { createBrowserRouter, Navigate } from "react-router-dom";

import { AdminLayout } from "../layouts/AdminLayout";
import { HomePage } from "../pages/HomePage";
import { DashboardPage } from "../pages/DashboardPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import LegacyAdminPage from "../features/legacy/LegacyAdminPage";
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
        path: "legacy",
        element: <LegacyAdminPage />,
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
        path: "market-diary",
        element: <MarketDiaryPage />,
      },
      {
        path: "settings",
        element: <SettingsPage />,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);

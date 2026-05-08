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

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section>
      <div className="page-header">
        <h1>{title}</h1>
        <p className="muted">This page is coming soon.</p>
      </div>
    </section>
  );
}

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
        path: "reports",
        element: <PlaceholderPage title="Reports" />,
      },
      {
        path: "system/events",
        element: <PlaceholderPage title="System Events" />,
      },
      {
        path: "settings",
        element: <PlaceholderPage title="Settings" />,
      },
    ],
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);

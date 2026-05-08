import { createBrowserRouter, Navigate } from "react-router-dom";

import { AdminLayout } from "../layouts/AdminLayout";
import { DashboardPage } from "../pages/DashboardPage";
import { LoginPage } from "../pages/LoginPage";
import { NotFoundPage } from "../pages/NotFoundPage";
import LegacyAdminPage from "../features/legacy/LegacyAdminPage";
import { SubscriptionsPage } from "../features/subscriptions/SubscriptionsPage";
import { ExitProfilesPage } from "../features/exitProfiles/ExitProfilesPage";

function PlaceholderPage({ title }: { title: string }) {
  return (
    <section>
      <h1 className="mb-2 text-2xl font-bold">{title}</h1>
      <p className="text-slate-400">
        This page will be extracted from the legacy admin app.
      </p>
    </section>
  );
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
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
        element: <PlaceholderPage title="Open Positions" />,
      },
      {
        path: "orders/open",
        element: <PlaceholderPage title="Open Orders" />,
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
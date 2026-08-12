// @vitest-environment happy-dom
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AuthProvider } from "../features/auth/AuthContext";
import type { AccessMetadata, PlatformRole, User } from "../features/auth/types";
import { RouteAccessGuard } from "./AdminLayout";

afterEach(cleanup);

function renderGuard(role: PlatformRole, routeId: "reports" | "users") {
  const access: AccessMetadata = {
    platformRole: role,
    permissions: ["reports.read", "system.settings.read"],
    accessibleTradingAccountIds: role === "SYSTEM_OWNER" ? null : [7],
  };
  const user = { id: 1, email: "user@example.com", name: "User", platformRole: role, enabled: true, lastLoginAt: null, createdAt: "", updatedAt: "" } satisfies User;
  return render(<MantineProvider><MemoryRouter><AuthProvider user={user} access={access}>
    <RouteAccessGuard routeId={routeId}><div>Protected page</div></RouteAccessGuard>
  </AuthProvider></MemoryRouter></MantineProvider>);
}

describe("direct route authorization", () => {
  it("renders a shared personal route for ACCOUNT_USER", () => {
    renderGuard("ACCOUNT_USER", "reports");
    expect(screen.getByText("Protected page")).toBeTruthy();
  });

  it.each(["OPERATOR", "ACCOUNT_USER"] as const)("renders Access Denied for %s on an owner-only route", (role) => {
    renderGuard(role, "users");
    expect(screen.queryByText("Protected page")).toBeNull();
    expect(screen.getByText("Access denied")).toBeTruthy();
  });
});

import {
  AppShell,
  Burger,
  Center,
  Divider,
  Group,
  Loader,
  NavLink,
  ScrollArea,
  Text,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";
import { adminNavGroups } from "../app/navigation";
import { filterNavigationGroups } from "../app/navigationUtils";
import { AuthProvider } from "../features/auth/AuthContext";
import { useLogout, useMe } from "../features/auth/hooks";
import { isAccountPortalRole } from "../features/auth/roleUtils";
import { useAuth } from "../features/auth/useAuth";
import { getAdminToken } from "../lib/api";

export function AdminLayout() {
  const token = getAdminToken();
  const { isLoading, isError, data: meData } = useMe(token);

  if (!token) return <Navigate to="/login" replace />;

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader color="cyan" />
      </Center>
    );
  }

  if (isError || !meData) return <Navigate to="/login" replace />;

  return (
    <AuthProvider
      user={meData.user}
      access={meData.access}
      isLoading={isLoading}
    >
      <Outlet />
    </AuthProvider>
  );
}

export function AdminConsoleGuard() {
  const { access } = useAuth();

  if (isAccountPortalRole(access?.platformRole)) {
    return <Navigate to="/portal" replace />;
  }

  return <Outlet />;
}

export function ViewerPortalGuard() {
  const { access } = useAuth();

  if (!isAccountPortalRole(access?.platformRole)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <Outlet />;
}

export function AdminConsoleShell() {
  const { access } = useAuth();
  const logoutMutation = useLogout(getAdminToken());
  const [opened, { toggle, close }] = useDisclosure();
  const isMobile = useMediaQuery("(max-width: 48em)") ?? false;
  const navigate = useNavigate();

  const filteredNavGroups = filterNavigationGroups(
    adminNavGroups,
    access?.platformRole,
    access?.permissions
  );

  async function handleLogout() {
    await logoutMutation.mutateAsync();
    navigate("/login", { replace: true });
  }

  return (
    <AppShell
      header={{ height: 60, collapsed: !isMobile }}
      navbar={{ width: 250, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <ThemeIcon size="md" radius="md" color="cyan" variant="filled">
              <Text size="xs" fw={700} c="white">AT</Text>
            </ThemeIcon>
            <Text fw={600} size="sm">AI Trader</Text>
          </Group>
          <Burger opened={opened} onClick={toggle} size="sm" />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar style={{ display: "flex", flexDirection: "column" }}>
        <AppShell.Section p="md">
          <Group gap="sm">
            <ThemeIcon size="lg" radius="md" color="cyan" variant="filled">
              <Text size="xs" fw={700} c="white">AT</Text>
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm" lh={1.3}>AI Trader</Text>
              <Text size="xs" c="dimmed" lh={1.3}>Admin Console</Text>
            </div>
          </Group>
        </AppShell.Section>

        <Divider />

        <AppShell.Section grow component={ScrollArea} p="xs">
          {filteredNavGroups.map((group) => (
            <div key={group.label}>
              <Text
                size="xs"
                fw={700}
                c="dimmed"
                tt="uppercase"
                px="sm"
                mt="md"
                mb={4}
                style={{ letterSpacing: "0.07em" }}
              >
                {group.label}
              </Text>
              {group.items.map((item) => (
                <AppNavLink
                  key={item.to}
                  to={item.to}
                  label={item.label}
                  onNavigate={close}
                />
              ))}
            </div>
          ))}
        </AppShell.Section>

        <Divider />

        <AppShell.Section p="sm">
          <SignOutButton
            isPending={logoutMutation.isPending}
            onClick={handleLogout}
          />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

export function ViewerPortalShell() {
  const { access } = useAuth();
  const logoutMutation = useLogout(getAdminToken());
  const [opened, { toggle, close }] = useDisclosure();
  const isMobile = useMediaQuery("(max-width: 48em)") ?? false;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const accountMatch = pathname.match(/^\/portal\/accounts\/(\d+)/);
  const routeAccountId = accountMatch?.[1] ?? null;
  const assignedAccountIds = access?.accessibleTradingAccountIds ?? [];
  const defaultAccountId =
    assignedAccountIds.length === 1 ? String(assignedAccountIds[0]) : null;
  const activeAccountId = routeAccountId ?? defaultAccountId;
  const accountBasePath = activeAccountId
    ? `/portal/accounts/${activeAccountId}`
    : null;
  const accountsActive =
    pathname === "/portal/accounts" ||
    (routeAccountId !== null && pathname === accountBasePath);

  async function handleLogout() {
    await logoutMutation.mutateAsync();
    navigate("/login", { replace: true });
  }

  return (
    <AppShell
      header={{ height: 60, collapsed: !isMobile }}
      navbar={{ width: 250, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <ThemeIcon size="md" radius="md" color="cyan" variant="filled">
              <Text size="xs" fw={700} c="white">AT</Text>
            </ThemeIcon>
            <Text fw={600} size="sm">AI Trader Portal</Text>
          </Group>
          <Burger opened={opened} onClick={toggle} size="sm" />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar style={{ display: "flex", flexDirection: "column" }}>
        <AppShell.Section p="md">
          <Group gap="sm">
            <ThemeIcon size="lg" radius="md" color="cyan" variant="filled">
              <Text size="xs" fw={700} c="white">AT</Text>
            </ThemeIcon>
            <div>
              <Text fw={600} size="sm" lh={1.3}>AI Trader</Text>
              <Text size="xs" c="dimmed" lh={1.3}>Account Portal</Text>
            </div>
          </Group>
        </AppShell.Section>

        <Divider />

        <AppShell.Section grow component={ScrollArea} p="xs">
          <Text
            size="xs"
            fw={700}
            c="dimmed"
            tt="uppercase"
            px="sm"
            mt="md"
            mb={4}
            style={{ letterSpacing: "0.07em" }}
          >
            Portal
          </Text>
          <NavLink
            label="Dashboard"
            active={pathname === "/portal"}
            onClick={() => {
              navigate("/portal");
              close();
            }}
          />
          <NavLink
            label="Accounts"
            active={accountsActive}
            onClick={() => {
              navigate("/portal/accounts");
              close();
            }}
          />
          {accountBasePath && (
            <>
              <NavLink
                label="Positions"
                active={pathname === `${accountBasePath}/positions`}
                onClick={() => {
                  navigate(`${accountBasePath}/positions`);
                  close();
                }}
              />
              <NavLink
                label="Orders"
                active={pathname === `${accountBasePath}/orders`}
                onClick={() => {
                  navigate(`${accountBasePath}/orders`);
                  close();
                }}
              />
              <NavLink
                label="Trade History"
                active={pathname === `${accountBasePath}/trade-history`}
                onClick={() => {
                  navigate(`${accountBasePath}/trade-history`);
                  close();
                }}
              />
            </>
          )}
        </AppShell.Section>

        <Divider />

        <AppShell.Section p="sm">
          <SignOutButton
            isPending={logoutMutation.isPending}
            onClick={handleLogout}
          />
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}

function SignOutButton({
  isPending,
  onClick,
}: {
  isPending: boolean;
  onClick: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      disabled={isPending}
      style={{
        display: "block",
        width: "100%",
        padding: "8px 12px",
        borderRadius: "var(--mantine-radius-sm)",
        color: "var(--mantine-color-red-4)",
        fontSize: "var(--mantine-font-size-sm)",
        transition: "background 150ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--mantine-color-dark-6)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {isPending ? "Signing out..." : "Sign out"}
    </UnstyledButton>
  );
}

function AppNavLink({
  to,
  label,
  onNavigate,
}: {
  to: string;
  label: string;
  onNavigate: () => void;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isActive = pathname === to || pathname.startsWith(to + "/");

  return (
    <NavLink
      label={label}
      active={isActive}
      onClick={() => {
        navigate(to);
        onNavigate();
      }}
    />
  );
}

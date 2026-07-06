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
import { getAdminToken } from "../lib/api";
import { useLogout, useMe } from "../features/auth/hooks";
import { adminNavGroups } from "../app/navigation";

export function AdminLayout() {
  const token = getAdminToken();
  const { isLoading, isError } = useMe(token);
  const navigate = useNavigate();
  const logoutMutation = useLogout(token);
  const [opened, { toggle, close }] = useDisclosure();
  const isMobile = useMediaQuery("(max-width: 48em)") ?? false;

  if (!token) return <Navigate to="/login" replace />;

  if (isLoading) {
    return (
      <Center h="100vh">
        <Loader color="cyan" />
      </Center>
    );
  }

  if (isError) return <Navigate to="/login" replace />;

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
          {adminNavGroups.map((group) => (
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
          <UnstyledButton
            onClick={handleLogout}
            disabled={logoutMutation.isPending}
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
            {logoutMutation.isPending ? "Signing out…" : "Sign out"}
          </UnstyledButton>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
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

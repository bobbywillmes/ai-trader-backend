import {
  AppShell,
  Burger,
  Divider,
  Group,
  NavLink,
  ScrollArea,
  Text,
  ThemeIcon,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { Outlet, useLocation, useNavigate } from "react-router-dom";

type NavGroup = {
  label: string;
  items: { to: string; label: string }[];
};

const navGroups: NavGroup[] = [
  {
    label: "Live Data",
    items: [
      { to: "/positions/open", label: "Open Positions" },
      { to: "/orders/open", label: "Open Orders" },
    ],
  },
  {
    label: "Trading",
    items: [
      { to: "/subscriptions", label: "Subscriptions" },
      { to: "/exit-profiles", label: "Exit Profiles" },
      { to: "/securities", label: "Securities" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/dashboard", label: "Dashboard" },
      { to: "/reports", label: "Reports" },
      { to: "/system/events", label: "System Events" },
      { to: "/settings", label: "Settings" },
      { to: "/legacy", label: "Legacy Admin" },
    ],
  },
];

export function AdminLayout() {
  const [opened, { toggle, close }] = useDisclosure();
  const isMobile = useMediaQuery("(max-width: 48em)") ?? false;

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

      <AppShell.Navbar>
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
          {navGroups.map((group) => (
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

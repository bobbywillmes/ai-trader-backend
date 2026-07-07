import { useState, useMemo } from "react";
import {
  Badge,
  Button,
  Card,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconPlus } from "@tabler/icons-react";
import { useAdminUsers } from "./hooks";
import { AdminUserDetailDrawer } from "./AdminUserDetailDrawer";
import { CreateAdminInviteModal } from "./CreateAdminInviteModal";

export function AdminUsersPage() {
  const { data: users, isLoading, error } = useAdminUsers();
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [inviteModalOpened, setInviteModalOpened] = useState(false);

  const stats = useMemo(() => {
    if (!users) return { total: 0, owners: 0, managers: 0, viewers: 0, pending: 0 };

    return {
      total: users.length,
      owners: users.filter((u) => u.role === "owner").length,
      managers: users.filter((u) => u.role === "account_manager").length,
      viewers: users.filter((u) => u.role === "account_viewer").length,
      pending: users.filter((u) => u.pendingSetup).length,
    };
  }, [users]);

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case "owner":
        return "red";
      case "account_manager":
        return "blue";
      case "account_viewer":
        return "gray";
      default:
        return "gray";
    }
  };

  const getRoleLabel = (role: string) => {
    switch (role) {
      case "owner":
        return "Owner";
      case "account_manager":
        return "Manager";
      case "account_viewer":
        return "Viewer";
      case "admin":
        return "Owner";
      default:
        return role;
    }
  };

  if (isLoading) {
    return (
      <Stack align="center" justify="center" h={400}>
        <Loader />
      </Stack>
    );
  }

  if (error) {
    return (
      <Stack>
        <Title order={2}>Users & Access</Title>
        <Card withBorder>
          <Text c="red">Error loading admin users: {String(error)}</Text>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-start">
        <div>
          <Title order={2}>Users & Access</Title>
          <Text c="dimmed" size="sm" mt={4}>
            Manage human admin users and their trading account access assignments.
          </Text>
        </div>

        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => setInviteModalOpened(true)}
        >
          Create Invite
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }} spacing="md">
        <Card withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: "0.07em" }} mb={6}>
            Total Users
          </Text>
          <Text size="xl" fw={700}>
            {stats.total}
          </Text>
        </Card>

        <Card withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: "0.07em" }} mb={6}>
            Owners
          </Text>
          <Text size="xl" fw={700}>
            {stats.owners}
          </Text>
        </Card>

        <Card withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: "0.07em" }} mb={6}>
            Managers
          </Text>
          <Text size="xl" fw={700}>
            {stats.managers}
          </Text>
        </Card>

        <Card withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: "0.07em" }} mb={6}>
            Viewers
          </Text>
          <Text size="xl" fw={700}>
            {stats.viewers}
          </Text>
        </Card>

        <Card withBorder radius="md" p="md">
          <Text size="xs" c="dimmed" tt="uppercase" fw={700} style={{ letterSpacing: "0.07em" }} mb={6}>
            Pending
          </Text>
          <Text size="xl" fw={700}>
            {stats.pending}
          </Text>
        </Card>
      </SimpleGrid>

      <Card withBorder>
        <Card.Section withBorder inheritPadding py="md">
          <Title order={3}>Admin Users</Title>
        </Card.Section>

        <Card.Section inheritPadding>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Email</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Role</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Last Login</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {users && users.length > 0 ? (
                users.map((user) => (
                  <Table.Tr
                    key={user.id}
                    onClick={() => setSelectedUserId(user.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {user.email}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{user.name || "—"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge
                        color={getRoleBadgeColor(user.role)}
                        variant="light"
                      >
                        {getRoleLabel(user.role)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs">
                        <Badge
                          color={user.enabled ? "green" : "gray"}
                          variant="light"
                        >
                          {user.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                        {user.pendingSetup ? (
                          <Badge color="yellow" variant="light">
                            Pending Setup
                          </Badge>
                        ) : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {user.lastLoginAt
                          ? new Date(user.lastLoginAt).toLocaleDateString()
                          : "Never"}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))
              ) : (
                <Table.Tr>
                  <Table.Td colSpan={5}>
                    <Text size="sm" c="dimmed" ta="center" py="xl">
                      No admin users found
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Card.Section>
      </Card>

      <AdminUserDetailDrawer
        userId={selectedUserId}
        onClose={() => setSelectedUserId(null)}
      />
      <CreateAdminInviteModal
        opened={inviteModalOpened}
        onClose={() => setInviteModalOpened(false)}
      />
    </Stack>
  );
}

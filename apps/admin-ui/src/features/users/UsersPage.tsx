import { useMemo } from "react";
import { Badge, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { getPlatformRoleColor, getPlatformRoleLabel } from "./roleLabels";
import { useUsers } from "./hooks";

export function UsersPage() {
  const { data: users, isLoading, error } = useUsers();
  const stats = useMemo(() => ({
    total: users?.length ?? 0,
    systemOwners: users?.filter((user) => user.platformRole === "SYSTEM_OWNER").length ?? 0,
    operators: users?.filter((user) => user.platformRole === "OPERATOR").length ?? 0,
    accountUsers: users?.filter((user) => user.platformRole === "ACCOUNT_USER").length ?? 0,
    pending: users?.filter((user) => user.pendingSetup).length ?? 0,
  }), [users]);

  if (isLoading) {
    return <Stack align="center" justify="center" h={400}><Loader /></Stack>;
  }

  if (error) {
    return <Stack><Title order={2}>Users & Access</Title><Card withBorder><Text c="red">Error loading users: {String(error)}</Text></Card></Stack>;
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Users & Access</Title>
        <Text c="dimmed" size="sm" mt={4}>
          Review platform roles and Trading Account membership scope.
        </Text>
      </div>

      <SimpleGrid cols={{ base: 1, sm: 2, md: 5 }} spacing="md">
        {[
          ["Total Users", stats.total],
          ["System Owners", stats.systemOwners],
          ["Operators", stats.operators],
          ["Account Users", stats.accountUsers],
          ["Pending", stats.pending],
        ].map(([label, value]) => (
          <Card key={label} withBorder radius="md" p="md">
            <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb={6}>{label}</Text>
            <Text size="xl" fw={700}>{value}</Text>
          </Card>
        ))}
      </SimpleGrid>

      <Card withBorder>
        <Card.Section withBorder inheritPadding py="md"><Title order={3}>Users</Title></Card.Section>
        <Card.Section inheritPadding>
          <Table striped highlightOnHover>
            <Table.Thead><Table.Tr><Table.Th>Email</Table.Th><Table.Th>Name</Table.Th><Table.Th>Platform Role</Table.Th><Table.Th>Status</Table.Th><Table.Th>Last Login</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {users?.length ? users.map((user) => (
                <Table.Tr key={user.id}>
                  <Table.Td><Text size="sm" fw={500}>{user.email}</Text></Table.Td>
                  <Table.Td><Text size="sm">{user.name || "—"}</Text></Table.Td>
                  <Table.Td><Badge color={getPlatformRoleColor(user.platformRole)} variant="light">{getPlatformRoleLabel(user.platformRole)}</Badge></Table.Td>
                  <Table.Td><Group gap="xs"><Badge color={user.enabled ? "green" : "gray"} variant="light">{user.enabled ? "Enabled" : "Disabled"}</Badge>{user.pendingSetup && <Badge color="yellow" variant="light">Pending Setup</Badge>}</Group></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : "Never"}</Text></Table.Td>
                </Table.Tr>
              )) : <Table.Tr><Table.Td colSpan={5}><Text size="sm" c="dimmed" ta="center" py="xl">No users found</Text></Table.Td></Table.Tr>}
            </Table.Tbody>
          </Table>
        </Card.Section>
      </Card>
    </Stack>
  );
}

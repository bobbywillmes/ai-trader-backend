import { useState, useEffect } from "react";
import {
  Drawer,
  Stack,
  Text,
  Badge,
  Divider,
  Loader,
  Table,
  Card,
  ScrollArea,
  Group,
  Button,
  TextInput,
  Select,
  Switch,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  useAdminUser,
  useAdminUserTradingAccountAccess,
  useUpdateAdminUser,
  useAdminUsers,
} from "./hooks";

interface AdminUserDetailDrawerProps {
  userId: number | null;
  onClose: () => void;
}

export function AdminUserDetailDrawer({
  userId,
  onClose,
}: AdminUserDetailDrawerProps) {
  const { data: user, isLoading } = useAdminUser(userId);
  const { data: accesses, isLoading: accessesLoading } =
    useAdminUserTradingAccountAccess(userId);
  const { data: allUsers } = useAdminUsers();
  const updateMutation = useUpdateAdminUser();

  const [isEditing, setIsEditing] = useState(false);
  const [formData, setFormData] = useState({
    name: user?.name || "",
    role: user?.role || "",
    enabled: user?.enabled ?? true,
  });

  const ownerCount =
    allUsers?.filter((u) => u.role === "owner" || u.role === "admin").length ??
    0;
  const userIsOwnerLike = user?.role === "owner" || user?.role === "admin";
  const isOnlyOwner = userIsOwnerLike && ownerCount === 1;
  const roleDisabled = isEditing && isOnlyOwner;

  useEffect(() => {
    if (user) {
      // Sync form with loaded user data
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData({
        name: user.name || "",
        role: user.role === "admin" ? "owner" : user.role || "",
        enabled: user.enabled ?? true,
      });
    }
  }, [user]);

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

  const handleSave = async () => {
    if (!user) return;

    if (!formData.role) {
      notifications.show({
        title: "Validation Error",
        message: "Role is required",
        color: "red",
      });
      return;
    }

    try {
      await updateMutation.mutateAsync({
        id: user.id,
        data: {
          name: formData.name || null,
          role: formData.role,
          enabled: formData.enabled,
        },
      });

      notifications.show({
        title: "Success",
        message: "Admin user updated successfully",
        color: "green",
      });

      setIsEditing(false);
    } catch (error) {
      notifications.show({
        title: "Error",
        message:
          error instanceof Error ? error.message : "Failed to update user",
        color: "red",
      });
    }
  };

  const handleCancel = () => {
    if (user) {
      setFormData({
        name: user.name || "",
        role: user.role || "",
        enabled: user.enabled ?? true,
      });
    }
    setIsEditing(false);
  };

  const handleDrawerClose = () => {
    setIsEditing(false);
    onClose();
  };

  return (
    <Drawer
      opened={userId !== null}
      onClose={handleDrawerClose}
      title={user?.email || "Loading..."}
      position="right"
      size="lg"
    >
      {isLoading ? (
        <Stack align="center" justify="center" h={300}>
          <Loader />
        </Stack>
      ) : user ? (
        <Stack gap="lg">
          <Card withBorder>
            {isEditing ? (
              <Stack gap="md">
                <TextInput
                  label="Name"
                  placeholder="Enter user name"
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.currentTarget.value })
                  }
                />

                <Select
                  label="Role"
                  placeholder="Select role"
                  value={formData.role}
                  onChange={(value) =>
                    setFormData({ ...formData, role: value || "" })
                  }
                  disabled={roleDisabled}
                  description={
                    roleDisabled
                      ? "Cannot demote the last owner"
                      : undefined
                  }
                  data={[
                    { value: "owner", label: "Owner" },
                    { value: "account_manager", label: "Manager" },
                    { value: "account_viewer", label: "Viewer" },
                  ]}
                />

                <Switch
                  label="Enabled"
                  checked={formData.enabled}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      enabled: e.currentTarget.checked,
                    })
                  }
                  disabled={roleDisabled}
                  description={
                    roleDisabled
                      ? "Cannot disable the last active owner"
                      : undefined
                  }
                />

                <Group justify="flex-end">
                  <Button
                    variant="default"
                    onClick={handleCancel}
                    disabled={updateMutation.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSave}
                    loading={updateMutation.isPending}
                  >
                    Save Changes
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Stack gap="sm">
                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Email
                  </Text>
                  <Text size="sm">{user.email}</Text>
                </div>

                <Divider />

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Name
                  </Text>
                  <Text size="sm">{user.name || "—"}</Text>
                </div>

                <Divider />

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Role
                  </Text>
                  <Badge color={getRoleBadgeColor(user.role)} variant="light">
                    {getRoleLabel(user.role)}
                  </Badge>
                </div>

                <Divider />

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Status
                  </Text>
                  <Badge
                    color={user.enabled ? "green" : "gray"}
                    variant="light"
                  >
                    {user.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>

                <Divider />

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Email Verified
                  </Text>
                  <Text size="sm">
                    {user.emailVerifiedAt
                      ? new Date(user.emailVerifiedAt).toLocaleDateString()
                      : "Not verified"}
                  </Text>
                </div>

                <Divider />

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Last Login
                  </Text>
                  <Text size="sm">
                    {user.lastLoginAt
                      ? new Date(user.lastLoginAt).toLocaleDateString()
                      : "Never"}
                  </Text>
                </div>

                <Divider />

                <div>
                  <Text size="xs" tt="uppercase" fw={700} c="dimmed" mb={4}>
                    Created
                  </Text>
                  <Text size="sm">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </Text>
                </div>

                <Group justify="flex-end" mt="md">
                  <Button onClick={() => setIsEditing(true)}>Edit User</Button>
                </Group>
              </Stack>
            )}
          </Card>

          <div>
            <Text size="sm" fw={600} mb="md">
              Trading Account Access
            </Text>

            {accessesLoading ? (
              <Stack align="center" justify="center" h={200}>
                <Loader size="sm" />
              </Stack>
            ) : accesses && accesses.length > 0 ? (
              <ScrollArea>
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Account</Table.Th>
                      <Table.Th>Access Role</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {accesses.map((access) => (
                      <Table.Tr key={access.tradingAccountId}>
                        <Table.Td>
                          <Text size="sm">{access.displayName}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge
                            color={getRoleBadgeColor(access.role)}
                            variant="light"
                            size="sm"
                          >
                            {getRoleLabel(access.role)}
                          </Badge>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            ) : (
              <Text size="sm" c="dimmed">
                No trading accounts assigned
              </Text>
            )}
          </div>
        </Stack>
      ) : null}
    </Drawer>
  );
}

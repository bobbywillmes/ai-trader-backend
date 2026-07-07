import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Checkbox,
  Code,
  CopyButton,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCheck, IconCopy, IconPlus } from "@tabler/icons-react";

import { getAdminToken } from "../../lib/api";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import { useCreateAdminUserInvitation } from "./hooks";
import type {
  AdminUserInviteAccessAssignment,
  AdminUserSetupLink,
  CreateAdminUserInvitationInput,
} from "./types";

type AdminRole = CreateAdminUserInvitationInput["role"];
type AccountAccessRole = AdminUserInviteAccessAssignment["role"];

interface CreateAdminInviteModalProps {
  opened: boolean;
  onClose: () => void;
}

const roleOptions: Array<{ value: AdminRole; label: string }> = [
  { value: "account_viewer", label: "Viewer" },
  { value: "account_manager", label: "Manager" },
  { value: "owner", label: "Owner" },
];

const accountRoleOptions: Array<{ value: AccountAccessRole; label: string }> = [
  { value: "VIEWER", label: "Viewer" },
  { value: "MANAGER", label: "Manager" },
  { value: "OWNER", label: "Owner" },
];

function buildSetupUrl(setupLink: AdminUserSetupLink | null) {
  if (!setupLink) {
    return "";
  }

  return new URL(setupLink.setupPath, window.location.origin).toString();
}

export function CreateAdminInviteModal({
  opened,
  onClose,
}: CreateAdminInviteModalProps) {
  const adminToken = getAdminToken();
  const { data: tradingAccountsData, isLoading: accountsLoading } =
    useTradingAccounts(adminToken);
  const createInviteMutation = useCreateAdminUserInvitation();

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AdminRole>("account_viewer");
  const [enabled, setEnabled] = useState(true);
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [accountRoles, setAccountRoles] = useState<
    Record<number, AccountAccessRole>
  >({});
  const [setupLink, setSetupLink] = useState<AdminUserSetupLink | null>(null);

  const tradingAccounts = tradingAccountsData?.accounts ?? [];
  const setupUrl = useMemo(() => buildSetupUrl(setupLink), [setupLink]);
  const accountAccessDisabled = role === "owner";

  const resetForm = () => {
    setEmail("");
    setName("");
    setRole("account_viewer");
    setEnabled(true);
    setSelectedAccountIds([]);
    setAccountRoles({});
    setSetupLink(null);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const toggleAccount = (accountId: number, checked: boolean) => {
    if (checked) {
      setSelectedAccountIds((current) =>
        current.includes(accountId) ? current : [...current, accountId]
      );
      setAccountRoles((current) => ({
        ...current,
        [accountId]: current[accountId] ?? "VIEWER",
      }));
      return;
    }

    setSelectedAccountIds((current) =>
      current.filter((selectedId) => selectedId !== accountId)
    );
  };

  const handleSubmit = async () => {
    if (!email.trim()) {
      notifications.show({
        title: "Validation Error",
        message: "Email is required",
        color: "red",
      });
      return;
    }

    if (!role) {
      notifications.show({
        title: "Validation Error",
        message: "Role is required",
        color: "red",
      });
      return;
    }

    const tradingAccountAccess = accountAccessDisabled
      ? []
      : selectedAccountIds.map((tradingAccountId) => ({
          tradingAccountId,
          role: accountRoles[tradingAccountId] ?? "VIEWER",
        }));

    try {
      const result = await createInviteMutation.mutateAsync({
        email: email.trim(),
        name: name.trim() || null,
        role,
        enabled,
        tradingAccountAccess,
      });

      setSetupLink(result.setupLink);
      notifications.show({
        title: "Invite created",
        message: "Setup link is ready to copy",
        color: "green",
      });
    } catch (error) {
      notifications.show({
        title: "Invite failed",
        message:
          error instanceof Error ? error.message : "Failed to create invite",
        color: "red",
      });
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="Create Invite"
      size="lg"
      centered
    >
      <Stack gap="md">
        <TextInput
          label="Email"
          placeholder="user@example.com"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          disabled={Boolean(setupLink)}
        />

        <TextInput
          label="Name"
          placeholder="Full name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
          disabled={Boolean(setupLink)}
        />

        <Select
          label="Role"
          data={roleOptions}
          value={role}
          onChange={(value) => setRole((value as AdminRole) || "account_viewer")}
          disabled={Boolean(setupLink)}
        />

        <Switch
          label="Enabled"
          checked={enabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
          disabled={Boolean(setupLink)}
        />

        {!accountAccessDisabled ? (
          <>
            <Divider />
            <div>
              <Group justify="space-between" mb="sm">
                <Text size="sm" fw={600}>
                  Trading Account Access
                </Text>
                <Badge variant="light">{selectedAccountIds.length} assigned</Badge>
              </Group>

              {accountsLoading ? (
                <Stack align="center" py="lg">
                  <Loader size="sm" />
                </Stack>
              ) : tradingAccounts.length > 0 ? (
                <ScrollArea.Autosize mah={260}>
                  <Table striped highlightOnHover>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Account</Table.Th>
                        <Table.Th>Access Role</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {tradingAccounts.map((account) => {
                        const checked = selectedAccountIds.includes(account.id);

                        return (
                          <Table.Tr key={account.id}>
                            <Table.Td>
                              <Checkbox
                                label={account.displayName}
                                checked={checked}
                                onChange={(event) =>
                                  toggleAccount(
                                    account.id,
                                    event.currentTarget.checked
                                  )
                                }
                                disabled={Boolean(setupLink)}
                              />
                            </Table.Td>
                            <Table.Td>
                              <Select
                                data={accountRoleOptions}
                                value={accountRoles[account.id] ?? "VIEWER"}
                                onChange={(value) =>
                                  setAccountRoles((current) => ({
                                    ...current,
                                    [account.id]:
                                      (value as AccountAccessRole) ?? "VIEWER",
                                  }))
                                }
                                disabled={!checked || Boolean(setupLink)}
                                size="xs"
                              />
                            </Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              ) : (
                <Text size="sm" c="dimmed">
                  No trading accounts available
                </Text>
              )}
            </div>
          </>
        ) : null}

        {setupLink ? (
          <>
            <Divider />
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Setup Link
              </Text>
              <Code block>{setupUrl}</Code>
              <Group justify="flex-end">
                <CopyButton value={setupUrl}>
                  {({ copied, copy }) => (
                    <Button
                      leftSection={
                        copied ? <IconCheck size={16} /> : <IconCopy size={16} />
                      }
                      color={copied ? "green" : undefined}
                      onClick={copy}
                    >
                      {copied ? "Copied" : "Copy Setup Link"}
                    </Button>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          </>
        ) : (
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={handleSubmit}
              loading={createInviteMutation.isPending}
            >
              Create Invite
            </Button>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}

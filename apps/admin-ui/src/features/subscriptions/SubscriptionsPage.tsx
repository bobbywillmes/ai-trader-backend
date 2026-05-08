import { useState, Fragment } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { Subscription } from "./types";
import { getAdminToken } from "../../lib/api";
import { useSetSubscriptionEnabled, useSubscriptions, useUpdateSubscription } from "./hooks";
import { useExitProfiles } from "../exitProfiles/hooks";

export function SubscriptionsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSizingValue, setEditSizingValue] = useState<string | number>("");
  const [editExitProfileKey, setEditExitProfileKey] = useState<string | null>(null);

  const {
    data: subscriptions = [],
    isLoading,
    isError,
    error,
  } = useSubscriptions(token);

  const { data: exitProfiles = [] } = useExitProfiles(token);
  const updateMutation = useUpdateSubscription(token);
  const toggleMutation = useSetSubscriptionEnabled(token);

  const exitProfileOptions = exitProfiles.map((ep) => ({ value: ep.key, label: ep.key }));

  function startEditing(sub: Subscription) {
    setEditingId(sub.id);
    setEditSizingValue(sub.sizingValue ?? "");
    setEditExitProfileKey(sub.exitProfile?.key ?? null);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditSizingValue("");
    setEditExitProfileKey(null);
  }

  async function handleToggle(id: number, enabled: boolean) {
    try {
      await toggleMutation.mutateAsync({ id, enabled });
      notifications.show({ message: `Subscription ${enabled ? "enabled" : "disabled"}.`, color: "teal" });
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to toggle subscription.",
        color: "red",
      });
    }
  }

  async function handleSave(id: number) {
    const sizingValue = Number(editSizingValue);
    if (!Number.isFinite(sizingValue) || sizingValue <= 0) {
      notifications.show({ message: "Sizing value must be a positive number.", color: "red" });
      return;
    }
    if (!editExitProfileKey) {
      notifications.show({ message: "Exit profile is required.", color: "red" });
      return;
    }
    try {
      await updateMutation.mutateAsync({ id, payload: { sizingValue, exitProfileKey: editExitProfileKey } });
      notifications.show({ message: "Subscription updated.", color: "teal" });
      cancelEditing();
    } catch (err) {
      notifications.show({
        message: err instanceof Error ? err.message : "Failed to update subscription.",
        color: "red",
      });
    }
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={2} size="h3">Subscriptions</Title>
        <Text size="sm" c="dimmed">View, edit, enable, and disable strategy subscriptions.</Text>
      </div>

      <Card withBorder radius="md" p="md">
        {isError && (
          <Alert color="red" mb="md">
            {error instanceof Error ? error.message : "Failed to load subscriptions."}
          </Alert>
        )}

        {isLoading && (
          <Group gap="sm">
            <Loader size="sm" color="cyan" />
            <Text size="sm" c="dimmed">Loading subscriptions…</Text>
          </Group>
        )}

        {!isLoading && subscriptions.length === 0 && (
          <Text size="sm" c="dimmed">No subscriptions.</Text>
        )}

        {subscriptions.length > 0 && (
          <ScrollArea>
            <Table striped highlightOnHover style={{ minWidth: 560 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Key</Table.Th>
                  <Table.Th>Symbol</Table.Th>
                  <Table.Th>Size</Table.Th>
                  <Table.Th>Exit Profile</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {subscriptions.map((sub) => {
                  const isEditing = editingId === sub.id;
                  return (
                    <Fragment key={sub.id}>
                      <Table.Tr>
                        <Table.Td fw={600}>{sub.key}</Table.Td>
                        <Table.Td>{sub.symbol}</Table.Td>
                        <Table.Td>
                          {sub.sizingValue} <Text span size="xs" c="dimmed">{sub.sizingType}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm" c="dimmed">{sub.exitProfile?.key ?? sub.exitProfileId}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="sm" color={sub.enabled ? "teal" : "gray"} variant="light">
                            {sub.enabled ? "Enabled" : "Disabled"}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          <Group gap="xs" justify="flex-end">
                            <Button
                              size="xs"
                              variant="subtle"
                              color={sub.enabled ? "red" : "teal"}
                              loading={toggleMutation.isPending && toggleMutation.variables?.id === sub.id}
                              onClick={() => handleToggle(sub.id, !sub.enabled)}
                            >
                              {sub.enabled ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              size="xs"
                              variant="subtle"
                              onClick={() => isEditing ? cancelEditing() : startEditing(sub)}
                            >
                              {isEditing ? "Cancel" : "Edit"}
                            </Button>
                          </Group>
                        </Table.Td>
                      </Table.Tr>

                      {isEditing && (
                        <Table.Tr>
                          <Table.Td colSpan={6} style={{ background: "var(--mantine-color-dark-7)" }}>
                            <Group gap="md" p="sm" align="flex-end" wrap="wrap">
                              <NumberInput
                                label="Sizing Value"
                                value={editSizingValue}
                                onChange={setEditSizingValue}
                                min={0}
                                step={1}
                                style={{ width: 140 }}
                                size="sm"
                              />
                              <Select
                                label="Exit Profile"
                                data={exitProfileOptions}
                                value={editExitProfileKey}
                                onChange={setEditExitProfileKey}
                                style={{ width: 200 }}
                                size="sm"
                              />
                              <Button
                                size="sm"
                                color="cyan"
                                loading={updateMutation.isPending}
                                onClick={() => handleSave(sub.id)}
                              >
                                Save
                              </Button>
                            </Group>
                          </Table.Td>
                        </Table.Tr>
                      )}
                    </Fragment>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>
    </Stack>
  );
}

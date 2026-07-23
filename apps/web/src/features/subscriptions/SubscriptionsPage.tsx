import { useMemo, useState } from "react";
import {
  Alert, Badge, Button, Card, Group, Loader, Modal, ScrollArea, Select,
  Stack, Switch, Table, Text, TextInput, Textarea, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useQuery } from "@tanstack/react-query";
import { getAdminToken } from "../../lib/api";
import { getSecurities } from "../securities/api";
import { useStrategies } from "../strategies/hooks";
import { useExitProfiles } from "../exitProfiles/hooks";
import {
  useCreateSubscription, useSetSubscriptionEnabled, useSubscriptions,
  useUpdateSubscription,
} from "./hooks";
import type { Subscription } from "./types";

type Draft = {
  key: string; name: string; description: string; symbol: string;
  strategyId: string | null; exitProfileId: string | null; enabled: boolean;
};

const emptyDraft: Draft = {
  key: "", name: "", description: "", symbol: "",
  strategyId: null, exitProfileId: null, enabled: true,
};

export function SubscriptionsPage() {
  const [token] = useState(() => getAdminToken());
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Subscription | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const subscriptionsQuery = useSubscriptions(token);
  const securitiesQuery = useQuery({
    queryKey: ["securities", "catalog-options"],
    queryFn: () => getSecurities(token as string),
    enabled: Boolean(token),
  });
  const strategiesQuery = useStrategies(token);
  const exitProfilesQuery = useExitProfiles(token);
  const createMutation = useCreateSubscription(token);
  const updateMutation = useUpdateSubscription(token);
  const toggleMutation = useSetSubscriptionEnabled(token);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (subscriptionsQuery.data ?? []).filter((item) =>
      !needle || [item.key, item.name, item.symbol, item.strategy.name,
        item.exitProfile.name].some((value) => value.toLowerCase().includes(needle))
    );
  }, [search, subscriptionsQuery.data]);

  function openCreate() {
    setDraft(emptyDraft);
    setEditing("new");
  }

  function openEdit(item: Subscription) {
    setDraft({
      key: item.key, name: item.name, description: item.description ?? "",
      symbol: item.security.symbol, strategyId: String(item.strategy.id),
      exitProfileId: String(item.exitProfile.id), enabled: item.enabled,
    });
    setEditing(item);
  }

  async function save() {
    if (!draft.key.trim() || !draft.name.trim() || !draft.symbol ||
        !draft.strategyId || !draft.exitProfileId) {
      notifications.show({ color: "red", message: "Complete all required catalog fields." });
      return;
    }
    const payload = {
      key: draft.key.trim().toLowerCase(), name: draft.name.trim(),
      description: draft.description.trim() || null, symbol: draft.symbol,
      strategyId: Number(draft.strategyId),
      exitProfileId: Number(draft.exitProfileId), enabled: draft.enabled,
    };
    try {
      if (editing === "new") await createMutation.mutateAsync(payload);
      else if (editing) await updateMutation.mutateAsync({ id: editing.id, payload });
      notifications.show({ color: "teal", message: "Subscription catalog saved." });
      setEditing(null);
    } catch (error) {
      notifications.show({ color: "red", message: error instanceof Error ? error.message : "Save failed." });
    }
  }

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="end">
        <div>
          <Title order={2} size="h3">Subscription Catalog</Title>
          <Text size="sm" c="dimmed">Global trading definitions. Account deployment and sizing are configured on each Trading Account.</Text>
        </div>
        <Button onClick={openCreate}>Create Subscription</Button>
      </Group>
      <Card withBorder>
        <TextInput mb="md" placeholder="Search key, ticker, strategy, or exit profile" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        {subscriptionsQuery.isError && <Alert color="red">{subscriptionsQuery.error.message}</Alert>}
        {subscriptionsQuery.isLoading ? <Loader size="sm" /> : rows.length === 0 ? (
          <Text c="dimmed">No catalog entries match this view.</Text>
        ) : (
          <ScrollArea>
            <Table striped highlightOnHover miw={900}>
              <Table.Thead><Table.Tr>
                <Table.Th>Definition</Table.Th><Table.Th>Strategy</Table.Th>
                <Table.Th>Exit profile</Table.Th><Table.Th>Global</Table.Th>
                <Table.Th>Assignments</Table.Th><Table.Th />
              </Table.Tr></Table.Thead>
              <Table.Tbody>{rows.map((item) => (
                <Table.Tr key={item.id}>
                  <Table.Td><Text fw={600}>{item.name}</Text><Text size="xs" ff="monospace">{item.key}</Text><Text size="xs" c="dimmed">{item.symbol} · {item.security.name}</Text></Table.Td>
                  <Table.Td>{item.strategy.name}</Table.Td>
                  <Table.Td>{item.exitProfile.name}</Table.Td>
                  <Table.Td><Badge color={item.enabled ? "teal" : "gray"}>{item.enabled ? "Enabled" : "Retired"}</Badge></Table.Td>
                  <Table.Td>
                    <Text size="sm">{item.accountSubscriptions.length} account{item.accountSubscriptions.length === 1 ? "" : "s"}</Text>
                    {item.accountSubscriptions.map((assignment) => (
                      <Text key={assignment.id} size="xs" c="dimmed">
                        {assignment.tradingAccount.displayName}: assignment {assignment.enabled ? "on" : "off"}, entries {assignment.entriesEnabled ? "on" : "off"}, exits {assignment.exitsEnabled ? "on" : "off"}
                      </Text>
                    ))}
                  </Table.Td>
                  <Table.Td><Group gap="xs" justify="flex-end">
                    <Button size="xs" variant="subtle" onClick={() => openEdit(item)}>Edit</Button>
                    <Button size="xs" variant="subtle" color={item.enabled ? "orange" : "teal"} onClick={() => toggleMutation.mutate({ id: item.id, enabled: !item.enabled })}>{item.enabled ? "Retire" : "Enable"}</Button>
                  </Group></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Card>
      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Create catalog Subscription" : "Edit catalog Subscription"} size="lg">
        <Stack>
          <Group grow><TextInput required label="Key" value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.currentTarget.value })} /><TextInput required label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })} /></Group>
          <Select searchable required label="Security" data={(securitiesQuery.data ?? []).map((item) => ({ value: item.symbol, label: `${item.symbol} — ${item.name}` }))} value={draft.symbol || null} onChange={(value) => setDraft({ ...draft, symbol: value ?? "" })} />
          <Group grow>
            <Select searchable required label="Strategy" data={(strategiesQuery.data ?? []).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.name}` }))} value={draft.strategyId} onChange={(value) => setDraft({ ...draft, strategyId: value })} />
            <Select searchable required label="Exit Profile" data={(exitProfilesQuery.data ?? []).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.name}` }))} value={draft.exitProfileId} onChange={(value) => setDraft({ ...draft, exitProfileId: value })} />
          </Group>
          <Textarea label="Description / notes" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })} />
          <Switch label="Globally enabled for new entries" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />
          <Alert color="blue">Creating a catalog definition assigns it to zero Trading Accounts.</Alert>
          <Group justify="flex-end"><Button variant="default" onClick={() => setEditing(null)}>Cancel</Button><Button loading={createMutation.isPending || updateMutation.isPending} onClick={save}>Save</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

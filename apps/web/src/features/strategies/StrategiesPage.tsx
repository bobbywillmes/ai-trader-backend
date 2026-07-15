import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Alert, Badge, Button, Card, Group, Loader, ScrollArea, Select, SimpleGrid,
  Stack, Table, Text, TextInput, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconEye, IconPower } from "@tabler/icons-react";

import { getAdminToken } from "../../lib/api";
import { useIsSystemOwner } from "../auth/useAuth";
import {
  useStrategies,
  useStrategyChangeImpact,
  useUpdateStrategyEnabled,
} from "./hooks";
import { StrategyStateModal } from "./StrategyStateModal";
import type { Strategy } from "./types";

function formatDateTime(value?: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

function badges(values: string[]) {
  if (!values.length) return <Text c="dimmed">-</Text>;
  return <Group gap={4}>{values.slice(0, 4).map((value) => <Badge key={value} color="gray" variant="light">{value}</Badge>)}{values.length > 4 && <Text size="xs">+{values.length - 4}</Text>}</Group>;
}

export function StrategiesPage() {
  const token = getAdminToken();
  const isOwner = useIsSystemOwner();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState<Strategy | null>(null);
  const strategies = useStrategies(token);
  const impact = useStrategyChangeImpact(selected?.id ?? null, token);
  const update = useUpdateStrategyEnabled(token);
  const rows = useMemo(() => (strategies.data ?? []).filter((strategy) => {
    if (status === "enabled" && !strategy.enabled) return false;
    if (status === "disabled" && strategy.enabled) return false;
    const term = search.trim().toLowerCase();
    return !term || [strategy.name, strategy.key, strategy.description, ...strategy.symbols].filter(Boolean).join(" ").toLowerCase().includes(term);
  }), [strategies.data, search, status]);

  async function confirmChange() {
    if (!selected) return;
    const enabled = !selected.enabled;
    try {
      await update.mutateAsync({ id: selected.id, enabled });
      notifications.show({ message: `${selected.name} ${enabled ? "enabled" : "disabled"}.`, color: "teal" });
      setSelected(null);
    } catch (error) {
      notifications.show({ title: "Strategy update failed", message: error instanceof Error ? error.message : "Unable to update strategy.", color: "red" });
    }
  }

  const data = strategies.data ?? [];
  return <Stack gap="lg">
    <Group justify="space-between" align="flex-start"><div><Title order={2}>Strategy Library</Title><Text size="sm" c="dimmed">Review strategy state and system-wide subscription usage.</Text></div>{!isOwner && <Badge color="cyan">Read only</Badge>}</Group>
    <SimpleGrid cols={{ base: 1, sm: 3 }}>
      <Card withBorder><Text size="xs" c="dimmed">STRATEGIES</Text><Text size="xl" fw={700}>{data.length}</Text></Card>
      <Card withBorder><Text size="xs" c="dimmed">ENABLED</Text><Text size="xl" fw={700}>{data.filter((item) => item.enabled).length}</Text></Card>
      <Card withBorder><Text size="xs" c="dimmed">ENABLED SUBSCRIPTIONS</Text><Text size="xl" fw={700}>{data.reduce((sum, item) => sum + item.activeSubscriptionCount, 0)}</Text></Card>
    </SimpleGrid>
    <Card withBorder>
      {strategies.isError && <Alert color="red">{strategies.error instanceof Error ? strategies.error.message : "Failed to load strategies."}</Alert>}
      {strategies.isLoading ? <Group><Loader size="sm" /><Text>Loading strategies...</Text></Group> : <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}><TextInput label="Search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} /><Select label="Status" value={status} onChange={(value) => setStatus(value ?? "all")} data={[{ value: "all", label: "All" }, { value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }]} /></SimpleGrid>
        <ScrollArea><Table striped highlightOnHover style={{ minWidth: 1000 }}><Table.Thead><Table.Tr><Table.Th>Strategy</Table.Th><Table.Th>Key</Table.Th><Table.Th>Status</Table.Th><Table.Th>Subscriptions</Table.Th><Table.Th>Symbols</Table.Th><Table.Th>Exit profiles</Table.Th><Table.Th>Updated</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>
          {rows.map((strategy) => <Table.Tr key={strategy.id}><Table.Td><Text fw={600}>{strategy.name}</Text><Text size="xs" c="dimmed" lineClamp={1}>{strategy.description}</Text></Table.Td><Table.Td><Text ff="monospace" size="sm">{strategy.key}</Text></Table.Td><Table.Td><Badge color={strategy.enabled ? "teal" : "gray"}>{strategy.enabled ? "Enabled" : "Disabled"}</Badge></Table.Td><Table.Td><Text fw={600}>{strategy.subscriptionCount}</Text><Text size="xs" c="dimmed">{strategy.activeSubscriptionCount} enabled</Text></Table.Td><Table.Td>{badges(strategy.symbols)}</Table.Td><Table.Td>{badges(strategy.exitProfiles.map((item) => item.name))}</Table.Td><Table.Td>{formatDateTime(strategy.updatedAt)}</Table.Td><Table.Td><Group justify="flex-end" wrap="nowrap"><Button component={Link} to={`/strategies/${strategy.id}`} size="xs" variant="subtle" leftSection={<IconEye size={14} />}>View</Button>{isOwner && <Button size="xs" variant="light" color={strategy.enabled ? "red" : "teal"} leftSection={<IconPower size={14} />} onClick={() => setSelected(strategy)}>{strategy.enabled ? "Disable" : "Enable"}</Button>}</Group></Table.Td></Table.Tr>)}
        </Table.Tbody></Table></ScrollArea>
      </Stack>}
    </Card>
    <StrategyStateModal opened={selected !== null} strategyName={selected?.name ?? "strategy"} nextEnabled={!(selected?.enabled ?? false)} impact={impact.data} loading={impact.isLoading} pending={update.isPending} error={impact.isError ? (impact.error instanceof Error ? impact.error.message : "Unable to load impact.") : null} onClose={() => !update.isPending && setSelected(null)} onConfirm={confirmChange} />
  </Stack>;
}

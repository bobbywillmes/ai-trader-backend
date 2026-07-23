import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  Alert, Anchor, Badge, Button, Card, Group, Loader, Pagination, ScrollArea,
  SimpleGrid, Stack, Table, Text, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowLeft, IconPower } from "@tabler/icons-react";

import { getAdminToken } from "../../lib/api";
import { useIsSystemOwner } from "../auth/useAuth";
import { StrategyStateModal } from "./StrategyStateModal";
import { useStrategy, useStrategyChangeImpact, useUpdateStrategyEnabled } from "./hooks";

function dateTime(value?: string) {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "-";
}

function sizing(type: string, value: number) {
  return type === "dollar_amount" ? `$${value.toLocaleString()}` : `${value.toLocaleString()} shares`;
}

export function StrategyDetailPage() {
  const params = useParams<{ strategyId: string }>();
  const parsedId = Number(params.strategyId);
  const id = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
  const token = getAdminToken();
  const isOwner = useIsSystemOwner();
  const [page, setPage] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const detail = useStrategy(id, page, token);
  const impact = useStrategyChangeImpact(confirming ? id : null, token);
  const update = useUpdateStrategyEnabled(token);
  const data = detail.data;

  async function confirmChange() {
    if (!data || !id) return;
    const enabled = !data.strategy.enabled;
    try {
      await update.mutateAsync({ id, enabled });
      notifications.show({ message: `${data.strategy.name} ${enabled ? "enabled" : "disabled"}.`, color: "teal" });
      setConfirming(false);
    } catch (error) {
      notifications.show({ title: "Strategy update failed", message: error instanceof Error ? error.message : "Unable to update strategy.", color: "red" });
    }
  }

  if (!id) return <Alert color="red">Invalid strategy ID.</Alert>;
  if (detail.isLoading) return <Group><Loader size="sm" /><Text>Loading strategy...</Text></Group>;
  if (detail.isError || !data) return <Stack><Button component={Link} to="/strategies" variant="subtle" leftSection={<IconArrowLeft size={16} />}>Back to strategies</Button><Alert color="red">{detail.error instanceof Error ? detail.error.message : "Strategy was not found."}</Alert></Stack>;

  return <Stack gap="lg">
    <Group justify="space-between" align="flex-start"><Stack gap={4}><Anchor component={Link} to="/strategies" size="sm"><Group gap={4}><IconArrowLeft size={14} />Back to strategies</Group></Anchor><Group><Title order={2}>{data.strategy.name}</Title><Badge color={data.strategy.enabled ? "teal" : "gray"}>{data.strategy.enabled ? "Enabled" : "Disabled"}</Badge></Group><Text ff="monospace" size="sm">{data.strategy.key}</Text><Text c="dimmed">{data.strategy.description ?? "No description configured."}</Text><Text size="xs" c="dimmed">Updated {dateTime(data.strategy.updatedAt)}</Text></Stack>{isOwner && <Button color={data.strategy.enabled ? "red" : "teal"} leftSection={<IconPower size={16} />} onClick={() => setConfirming(true)}>{data.strategy.enabled ? "Disable strategy" : "Enable strategy"}</Button>}</Group>
    <SimpleGrid cols={{ base: 1, sm: 3 }}><Card withBorder><Text size="xs" c="dimmed">TOTAL SUBSCRIPTIONS</Text><Text size="xl" fw={700}>{data.usage.totalSubscriptions}</Text></Card><Card withBorder><Text size="xs" c="dimmed">ENABLED</Text><Text size="xl" fw={700}>{data.usage.enabledSubscriptions}</Text></Card><Card withBorder><Text size="xs" c="dimmed">DISABLED</Text><Text size="xl" fw={700}>{data.usage.disabledSubscriptions}</Text></Card></SimpleGrid>
    <Card withBorder><Stack><Title order={3} size="h4">Usage</Title><Text size="sm"><strong>Symbols:</strong> {data.usage.symbols.join(", ") || "None"}</Text><Text size="sm"><strong>Trading accounts:</strong> {data.usage.tradingAccounts.map((item) => item.displayName).join(", ") || "None"}</Text><Text size="sm"><strong>Exit profiles:</strong> {data.usage.exitProfiles.map((item) => `${item.name} (${item.subscriptionCount})`).join(", ") || "None"}</Text></Stack></Card>
    {data.implications.momentumStrategy && <Alert color={data.strategy.enabled ? "blue" : "yellow"} title="Momentum eligibility implications"><Text size="sm">{data.implications.eligibilityMessage}</Text><Text size="xs" mt="xs">{data.implications.enabledMomentumSubscriptions} enabled linked subscription(s); {data.implications.currentlyQualifyingMomentumSubscriptions} currently satisfy the complete hierarchy. Strategy state remains separate from subscription, account, allocation, and risk controls.</Text></Alert>}
    <Card withBorder><Stack><Title order={3} size="h4">Linked subscriptions</Title><ScrollArea><Table striped highlightOnHover style={{ minWidth: 1000 }}><Table.Thead><Table.Tr><Table.Th>Symbol</Table.Th><Table.Th>Subscription</Table.Th><Table.Th>Status</Table.Th><Table.Th>Trading account</Table.Th><Table.Th>Allocation</Table.Th><Table.Th>Exit profile</Table.Th><Table.Th>Sizing</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{data.subscriptions.data.map((subscription) => {
      const assignments = subscription.accountSubscriptions;
      return <Table.Tr key={subscription.id}><Table.Td><Text fw={600}>{subscription.symbol}</Text><Text size="xs" c="dimmed">{subscription.security.name}</Text></Table.Td><Table.Td><Text>{subscription.name}</Text><Text ff="monospace" size="xs">{subscription.key}</Text></Table.Td><Table.Td><Badge color={subscription.enabled ? "teal" : "gray"}>{subscription.enabled ? "Enabled" : "Retired"}</Badge></Table.Td><Table.Td>{assignments.length ? assignments.map((item) => <Anchor component={Link} key={item.id} to={`/trading-accounts/${item.tradingAccount.id}?tab=subscriptions`} display="block">{item.tradingAccount.displayName}</Anchor>) : <Text c="dimmed">Unassigned</Text>}</Table.Td><Table.Td>{assignments.length ? assignments.map((item) => <Text key={item.id} size="sm" c={item.allocation?.enabled === false ? "red" : undefined}>{item.allocation ? `${item.allocation.name} (${item.allocation.enabled ? "enabled" : "disabled"})` : "No allocation"}</Text>) : <Text c="dimmed">-</Text>}</Table.Td><Table.Td>{subscription.exitProfile.name}</Table.Td><Table.Td>{assignments.length ? assignments.map((item) => <Text key={item.id} size="sm">{item.sizingType === "FIXED_QTY" ? sizing(item.sizingType, item.fixedQty ?? 0) : sizing(item.sizingType, item.maxPositionNotional ?? 0)}</Text>) : <Text c="dimmed">-</Text>}</Table.Td></Table.Tr>;
    })}</Table.Tbody></Table></ScrollArea>{data.subscriptions.pagination.totalPages > 1 && <Group justify="flex-end"><Pagination value={page} total={data.subscriptions.pagination.totalPages} onChange={setPage} /></Group>}</Stack></Card>
    <StrategyStateModal opened={confirming} strategyName={data.strategy.name} nextEnabled={!data.strategy.enabled} impact={impact.data} loading={impact.isLoading} pending={update.isPending} error={impact.isError ? (impact.error instanceof Error ? impact.error.message : "Unable to load impact.") : null} onClose={() => !update.isPending && setConfirming(false)} onConfirm={confirmChange} />
  </Stack>;
}

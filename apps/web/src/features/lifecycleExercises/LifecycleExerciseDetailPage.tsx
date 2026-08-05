import { useState } from "react";
import { Alert, Badge, Button, Card, Divider, Group, Loader, Stack, Table, Text, TextInput, Timeline, Title } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { closePosition } from "../positions/api";
import { lifecycleExerciseKeys, useLifecycleExercise, useLifecycleExerciseMutations } from "./hooks";
import classes from "./LifecycleExerciseDetailPage.module.css";

const activeStages = new Set(["POSITION_OPEN", "EXIT_MONITORING", "PROTECTIVE_ORDER_ACTIVE"]);

export function LifecycleExerciseDetailPage() {
  const id = Number(useParams().id);
  const [token] = useState(() => getAdminToken());
  const query = useLifecycleExercise(token, id);
  const mutations = useLifecycleExerciseMutations(token);
  const client = useQueryClient();
  const [cancelReason, setCancelReason] = useState("");
  const closeMutation = useMutation({
    mutationFn: (positionId: number) => closePosition(positionId, token as string),
    onSuccess: () => client.invalidateQueries({ queryKey: lifecycleExerciseKeys.detail(id) }),
  });
  if (query.isLoading) return <Group><Loader size="sm" /><Text>Loading lifecycle exercise…</Text></Group>;
  if (query.isError || !query.data) return <Alert color="red">Unable to load lifecycle exercise.</Alert>;
  const exercise = query.data.exercise;
  const targets = exercise.targets ?? [];
  const counts = targets.reduce<Record<string, number>>((result, target) => {
    const stage = target.projection?.stage ?? target.status;
    result[stage] = (result[stage] ?? 0) + 1;
    return result;
  }, {});
  const cancellable = !["COMPLETED", "FAILED", "CANCELLED"].includes(exercise.status);

  return (
    <Stack gap="lg" className={classes.page}>
      <Group justify="space-between" align="flex-start" className={classes.header}>
        <div><Title order={2}>Exercise #{exercise.id}: {exercise.name ?? exercise.subscription.name}</Title><Text c="dimmed">{exercise.reason}</Text></div>
        <Group><Badge color="cyan">PAPER</Badge><Badge>{exercise.status}</Badge><Button variant="default" onClick={() => query.refetch()} loading={query.isFetching}>Refresh</Button></Group>
      </Group>
      {exercise.cancelledAt && <Alert color="yellow" title="Exercise cancelled">Only undispatched targets were cancelled. Orders and positions already created continue through normal lifecycle management.</Alert>}
      <Card withBorder><Stack>
        <Group grow className={classes.summary}>
          <div><Text size="xs" c="dimmed">Subscription</Text><Text fw={600}>{exercise.subscription.name} ({exercise.subscription.key})</Text></div>
          <div><Text size="xs" c="dimmed">Selection</Text><Text fw={600}>{exercise.selectionMode === "ALL_ELIGIBLE" ? "Everyone eligible" : `${exercise.requestedUserIdsJson.length} selected users`}</Text></div>
          <div><Text size="xs" c="dimmed">Previewed</Text><Text fw={600}>{new Date(exercise.previewedAt).toLocaleString()}</Text></div>
          <div><Text size="xs" c="dimmed">Launched</Text><Text fw={600}>{exercise.launchedAt ? new Date(exercise.launchedAt).toLocaleString() : "Not launched"}</Text></div>
        </Group>
        <Group>{Object.entries(counts).map(([stage, count]) => <Badge key={stage} variant="light">{stage}: {count}</Badge>)}</Group>
        {cancellable && <Group align="flex-end" className={classes.consequential}><TextInput label="Cancellation reason" value={cancelReason} onChange={(event) => setCancelReason(event.currentTarget.value)} className={classes.reason} /><Button color="red" variant="light" disabled={!cancelReason.trim()} loading={mutations.cancel.isPending} onClick={() => mutations.cancel.mutate({ id, reason: cancelReason })}>Cancel undispatched work</Button></Group>}
      </Stack></Card>
      {targets.map((target) => {
        const projection = target.projection;
        const positionId = projection?.links.trackedPositionId;
        return <Card key={target.id} withBorder>
          <Stack>
            <Group justify="space-between">
              <div><Title order={4}>{target.tradingAccount?.displayName ?? `Trading Account #${target.tradingAccountId}`}</Title><Text size="sm" c="dimmed">{target.accountHolderUser?.name ?? target.accountHolderUser?.email ?? `User target`} · Assignment #{target.tradingAccountSubscriptionId}</Text></div>
              <Badge color={projection?.stage === "ATTENTION_REQUIRED" ? "orange" : projection?.stage === "RECONCILED" ? "teal" : "blue"}>{projection?.stage ?? target.status}</Badge>
            </Group>
            {(target.blockersJson?.length ?? 0) > 0 && <Alert color="red" title="Blockers">{target.blockersJson.map((item) => `${item.code}: ${item.message}`).join(" · ")}</Alert>}
            {(target.warningsJson?.length ?? 0) > 0 && <Alert color="yellow" title="Warnings">{target.warningsJson.map((item) => `${item.code}: ${item.message}`).join(" · ")}</Alert>}
            <div className={classes.targetFacts}><Table withTableBorder><Table.Tbody>
              <Table.Tr><Table.Th>Quantity</Table.Th><Table.Td>{target.resolvedQuantity ?? "—"}</Table.Td><Table.Th>Estimated notional</Table.Th><Table.Td>{target.estimatedNotional ? `$${target.estimatedNotional.toFixed(2)}` : "—"}</Table.Td></Table.Tr>
              {target.readinessJson?.positionSlotUsage && <Table.Tr><Table.Th>Position slot limit</Table.Th><Table.Td>{target.readinessJson.positionSlotUsage.accountMaxPositions ?? "Unlimited"}</Table.Td><Table.Th>Projected usage</Table.Th><Table.Td>{target.readinessJson.positionSlotUsage.activePositionCount} active + {target.readinessJson.positionSlotUsage.pendingEntryIntentSlotCount} pending = {target.readinessJson.positionSlotUsage.usedSlots}; +{target.readinessJson.positionSlotUsage.proposedAdditionalSlots} proposed → {target.readinessJson.positionSlotUsage.projectedSlotCount}</Table.Td></Table.Tr>}
              <Table.Tr><Table.Th>Order intent</Table.Th><Table.Td>{projection?.links.orderIntentId ?? "—"}</Table.Td><Table.Th>Broker orders</Table.Th><Table.Td>{projection?.links.brokerOrderIds.join(", ") || "—"}</Table.Td></Table.Tr>
              <Table.Tr><Table.Th>Tracked position</Table.Th><Table.Td>{positionId ?? "—"}</Table.Td><Table.Th>Exit state</Table.Th><Table.Td>{projection?.links.positionExitStateId ?? "—"}</Table.Td></Table.Tr>
            </Table.Tbody></Table></div>
            <Group className={classes.actions}>
              <Button component={Link} to={`/trading-accounts/${target.tradingAccountId}`} variant="default" size="xs">Trading account</Button>
              {positionId && <Button component={Link} to="/positions/open" variant="default" size="xs">Open positions</Button>}
              {positionId && projection && activeStages.has(projection.stage) && <Button color="orange" size="xs" loading={closeMutation.isPending && closeMutation.variables === positionId} onClick={() => closeMutation.mutate(positionId)}>Manual close</Button>}
              <Button size="xs" variant="light" loading={mutations.reconcile.isPending} onClick={() => mutations.reconcile.mutate({ exerciseId: exercise.id, targetId: target.id })}>Run diagnostic reconciliation</Button>
            </Group>
            {positionId && projection && activeStages.has(projection.stage) && <Text size="xs" c="dimmed">Manual close uses the existing account-scoped close workflow. Completion still requires imported closing fills, position closure, and clean reconciliation.</Text>}
            <Divider />
            <Title order={5}>Authoritative timeline</Title>
            <Timeline bulletSize={18} lineWidth={2}>
              {(projection?.timeline ?? []).map((event) => <Timeline.Item key={event.key} title={event.label}><Text size="xs" c="dimmed">{new Date(event.at).toLocaleString()} · {event.entityType} #{event.entityId}</Text></Timeline.Item>)}
            </Timeline>
          </Stack>
        </Card>;
      })}
    </Stack>
  );
}

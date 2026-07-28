import { useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, MultiSelect, ScrollArea, SegmentedControl, Select, Stack, Switch, Table, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { getSubscriptions } from "../subscriptions/api";
import { listUsers } from "../users/api";
import { useLifecycleExerciseMutations, useLifecycleExercises } from "./hooks";
import {
  buildLifecycleExercisePreviewPayload,
  canLaunchPaperExercise,
  DEFAULT_LIFECYCLE_EXERCISE_REASON,
  showsSelectedAccountHolders,
  updateGeneratedExerciseName,
} from "./exerciseForm";

const statusColor = (status: string) =>
  status === "RUNNING" ? "blue" : status === "COMPLETED" ? "teal" : status === "BLOCKED" || status === "FAILED" ? "red" : status === "ATTENTION_REQUIRED" ? "orange" : "gray";

export function LifecycleExercisesPage() {
  const [token] = useState(() => getAdminToken());
  const exercises = useLifecycleExercises(token);
  const mutations = useLifecycleExerciseMutations(token);
  const subscriptions = useQuery({ queryKey: ["subscriptions", "lifecycle-exercises"], queryFn: () => getSubscriptions(token as string), enabled: Boolean(token) });
  const users = useQuery({ queryKey: ["users", "lifecycle-exercises"], queryFn: listUsers, enabled: Boolean(token) });
  const [name, setName] = useState("");
  const nameManuallyEdited = useRef(false);
  const [reason, setReason] = useState(DEFAULT_LIFECYCLE_EXERCISE_REASON);
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState<"SELECTED_USERS" | "ALL_ELIGIBLE">("SELECTED_USERS");
  const [userIds, setUserIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof mutations.preview.mutateAsync>>["exercise"] | null>(null);
  const [launchConfirmed, setLaunchConfirmed] = useState(false);

  async function createPreview() {
    const response = await mutations.preview.mutateAsync(
      buildLifecycleExercisePreviewPayload({
        name,
        reason,
        subscriptionId: subscriptionId as string,
        selectionMode,
        userIds,
      }),
    );
    setPreview(response.exercise);
    setLaunchConfirmed(false);
  }

  async function launch() {
    if (!preview || !canLaunchPaperExercise(launchConfirmed)) return;
    const response = await mutations.launch.mutateAsync(preview.id);
    setPreview(response.exercise);
  }

  const rows = exercises.data?.exercises ?? [];
  return (
    <Stack gap="lg">
      <div>
        <Title order={2}>Lifecycle Exercises</Title>
        <Text c="dimmed">Controlled, durable Paper-only checks of the complete trading lifecycle.</Text>
      </div>
      <Alert color="blue" title="Paper-only safety boundary">
        Live and mixed-environment exercises are rejected by the backend. Exercises use configured sizing and normal risk controls.
      </Alert>
      <Card withBorder>
        <Stack>
          <Title order={4}>Create and preview</Title>
          <Group grow align="flex-end">
            <Select label="Catalog subscription" searchable value={subscriptionId} onChange={(value) => {
              setSubscriptionId(value);
              if (!nameManuallyEdited.current && value) {
                const subscription = subscriptions.data?.find((item) => item.id === Number(value));
                if (subscription) {
                  setName(updateGeneratedExerciseName({
                    currentName: name,
                    manuallyEdited: nameManuallyEdited.current,
                    subscriptionName: subscription.name,
                  }));
                }
              }
            }}
              data={(subscriptions.data ?? []).map((item) => ({ value: String(item.id), label: `${item.name} (${item.key})` }))} />
            <TextInput label="Exercise name" value={name} onChange={(event) => {
              nameManuallyEdited.current = true;
              setName(event.currentTarget.value);
            }} />
            <Select label="Environment" value="PAPER" data={[{ value: "PAPER", label: "Paper" }, { value: "LIVE", label: "Live — not available yet", disabled: true }]} />
          </Group>
          <TextInput required label="Reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
          <Stack gap={6} align="flex-start">
            <Text size="sm" fw={500}>Account holders</Text>
            <SegmentedControl
              aria-label="Account holder selection mode"
              size="sm"
              value={selectionMode}
              onChange={(value) => setSelectionMode(value as typeof selectionMode)}
              data={[
                { value: "SELECTED_USERS", label: "Selected users" },
                { value: "ALL_ELIGIBLE", label: "Everyone eligible" },
              ]}
            />
          </Stack>
          {showsSelectedAccountHolders(selectionMode) && (
            <MultiSelect searchable label="Selected account holders" value={userIds} onChange={setUserIds}
              styles={{ inputField: { minWidth: "8rem", paddingInlineStart: "var(--mantine-spacing-xs)" } }}
              data={(users.data ?? []).map((user) => ({ value: String(user.id), label: `${user.name ?? user.email}${user.enabled ? "" : " (disabled)"}` }))} />
          )}
          <Group>
            <Button onClick={createPreview} loading={mutations.preview.isPending}
              disabled={!subscriptionId || !reason.trim() || (selectionMode === "SELECTED_USERS" && !userIds.length)}>
              Preview frozen targets
            </Button>
            <Text size="sm" c="dimmed">Preview expires after five minutes and creates no order intent or broker write.</Text>
          </Group>
          {mutations.preview.isError && <Alert color="red">{mutations.preview.error.message}</Alert>}
          {preview && (
            <Stack>
              <Group justify="space-between">
                <Title order={5}>Preview #{preview.id}</Title>
                <Badge color={statusColor(preview.status)}>{preview.status}</Badge>
              </Group>
              {(preview.selectionResultsJson ?? []).map((result, index) => (
                <Alert key={`${result.userId}-${result.code}-${index}`} color="yellow">
                  User {result.name ?? result.email ?? result.userId}: {result.code}
                </Alert>
              ))}
              <ScrollArea>
                <Table striped withTableBorder miw={900}>
                  <Table.Thead><Table.Tr><Table.Th>Account</Table.Th><Table.Th>Assignment</Table.Th><Table.Th>Qty</Table.Th><Table.Th>Estimated notional</Table.Th><Table.Th>Readiness</Table.Th><Table.Th>Blockers / warnings</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>{(preview.targets ?? []).map((target) => (
                    <Table.Tr key={target.id}>
                      <Table.Td>#{target.tradingAccountId}</Table.Td><Table.Td>#{target.tradingAccountSubscriptionId}</Table.Td>
                      <Table.Td>{target.resolvedQuantity ?? "—"}</Table.Td><Table.Td>{target.estimatedNotional ? `$${target.estimatedNotional.toFixed(2)}` : "—"}</Table.Td>
                      <Table.Td><Badge color={target.status === "READY" ? "teal" : "red"}>{target.status}</Badge></Table.Td>
                      <Table.Td>{[...(target.blockersJson ?? []), ...(target.warningsJson ?? [])].map((item) => item.code).join(", ") || "None"}</Table.Td>
                    </Table.Tr>
                  ))}</Table.Tbody>
                </Table>
              </ScrollArea>
              {preview.status === "PREVIEWED" && (
                <Card withBorder radius="md" p="md">
                  <Stack gap="md" align="flex-start">
                    <Switch
                      checked={launchConfirmed}
                      onChange={(event) => setLaunchConfirmed(event.currentTarget.checked)}
                      label="I confirm this exercise will dispatch entries to the reviewed Paper targets."
                      description="Configured sizing, risk controls, and the normal trading lifecycle remain authoritative."
                    />
                    <Button
                      color="orange"
                      onClick={launch}
                      loading={mutations.launch.isPending}
                      disabled={!canLaunchPaperExercise(launchConfirmed)}
                    >
                      Launch Paper exercise
                    </Button>
                  </Stack>
                </Card>
              )}
              {mutations.launch.isError && <Alert color="red">{mutations.launch.error.message}</Alert>}
            </Stack>
          )}
        </Stack>
      </Card>
      <Card withBorder>
        <Stack>
          <Group justify="space-between"><Title order={4}>Exercise history</Title><Button variant="default" onClick={() => exercises.refetch()} loading={exercises.isFetching}>Refresh</Button></Group>
          {!rows.length && !exercises.isLoading && <Text c="dimmed">No lifecycle exercises yet.</Text>}
          <ScrollArea>
            <Table striped highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>Exercise</Table.Th><Table.Th>Subscription</Table.Th><Table.Th>Environment</Table.Th><Table.Th>Status</Table.Th><Table.Th>Creator</Table.Th><Table.Th>Targets</Table.Th><Table.Th>Created</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>{rows.map((exercise) => (
                <Table.Tr key={exercise.id}>
                  <Table.Td>#{exercise.id} {exercise.name ?? ""}</Table.Td><Table.Td>{exercise.subscription.name}</Table.Td>
                  <Table.Td><Badge color="cyan">PAPER</Badge></Table.Td><Table.Td><Badge color={statusColor(exercise.status)}>{exercise.status}</Badge></Table.Td>
                  <Table.Td>{exercise.createdByUser.name ?? exercise.createdByUser.email}</Table.Td><Table.Td>{exercise._count?.targets ?? 0}</Table.Td>
                  <Table.Td>{new Date(exercise.createdAt).toLocaleString()}</Table.Td>
                  <Table.Td><Button component={Link} to={`/lifecycle-exercises/${exercise.id}`} size="xs" variant="default">View</Button></Table.Td>
                </Table.Tr>
              ))}</Table.Tbody>
            </Table>
          </ScrollArea>
        </Stack>
      </Card>
    </Stack>
  );
}

import { Alert, Badge, Card, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";

import type { MomentumPipelineRun } from "../types";

const stageFields = [
  ["News", "newsResult"],
  ["Expiration", "expirationResult"],
  ["Candidates", "candidateResult"],
  ["Price", "priceResult"],
  ["Handoffs", "handoffResult"],
  ["Delivery", "deliveryResult"],
] as const;

function formatNewYork(value: string | null) {
  if (!value) return "Not completed";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value))}`;
}

function formatDuration(value: number | null) {
  if (value === null) return "—";
  return value < 60_000 ? `${(value / 1000).toFixed(1)}s` : `${(value / 60_000).toFixed(1)}m`;
}

function resultSummary(value: unknown) {
  if (!value || typeof value !== "object") return "Not recorded";
  const wrapper = value as { status?: string; result?: Record<string, unknown> };
  const entries = Object.entries(wrapper.result ?? {})
    .filter(([, item]) => typeof item === "number" || typeof item === "string")
    .slice(0, 3)
    .map(([key, item]) => `${key.replace(/([A-Z])/g, " $1").toLowerCase()}: ${String(item)}`);
  return entries.length ? entries.join(" · ") : wrapper.status ?? "Recorded";
}

function statusColor(status: MomentumPipelineRun["status"]) {
  if (status === "SUCCEEDED") return "teal";
  if (status === "RUNNING") return "blue";
  if (status === "PARTIAL") return "yellow";
  return "red";
}

export function MomentumPipelineRunSummary({ run, title = "Last pipeline run" }: { run: MomentumPipelineRun | null; title?: string }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between" align="flex-start">
          <div><Title order={3}>{title}</Title><Text size="sm" c="dimmed">Durable full-workflow status · New York time</Text></div>
          {run && <Badge color={statusColor(run.status)} variant="light">{run.status.replaceAll("_", " ")}</Badge>}
        </Group>
        {!run ? <Text c="dimmed">No pipeline run has been recorded.</Text> : <>
          <Group gap="lg"><Text size="sm"><b>Started:</b> {formatNewYork(run.startedAt)}</Text><Text size="sm"><b>Duration:</b> {formatDuration(run.durationMs)}</Text><Text size="sm"><b>Source:</b> {run.source.replaceAll("_", " ")}</Text></Group>
          {run.currentStage && <Text size="sm"><b>{run.status === "RUNNING" ? "Current" : "Last"} stage:</b> {run.currentStage.replaceAll("_", " ")}</Text>}
          {run.errorMessage && <Alert color="red" title={`${run.errorStage?.replaceAll("_", " ") ?? "Pipeline"} failed`}>{run.errorMessage}</Alert>}
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>{stageFields.map(([label, field]) => <div key={field}><Text size="xs" fw={700} tt="uppercase" c="dimmed">{label}</Text><Text size="sm">{resultSummary(run[field])}</Text></div>)}</SimpleGrid>
        </>}
      </Stack>
    </Card>
  );
}

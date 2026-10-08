import { Card, Group, Stack, Text } from "@mantine/core";
import { StatusBadge } from "../../components/data-display";
import { assessmentFreshness, formatDateTime, freshnessTone, label } from "./presentation";
import type { DimensionSummary } from "./types";
export function DimensionSummaryCard({ title, summary, compact = false }: { title: string; summary: DimensionSummary; compact?: boolean }) {
  const attempt = summary.latestAttempt; const freshness = assessmentFreshness(attempt);
  return <Card withBorder p={compact ? "sm" : "md"}>
    <Stack gap="xs"><Group justify="space-between" align="flex-start"><Text fw={700}>{title}</Text><StatusBadge status={freshness} tone={freshnessTone(freshness)} size="compact" /></Group>
      <Text size={compact ? "lg" : "xl"} fw={750}>{attempt?.effectiveState ? label(attempt.effectiveState) : "Unavailable"}</Text>
      {!compact && <><Text size="sm">Raw state: <b>{attempt?.rawState ? label(attempt.rawState) : "Unavailable"}</b></Text><Text size="xs" c="dimmed">{summary.algorithmVersion} · evidence schema {attempt?.evidenceSchemaVersion ?? "—"}</Text></>}
      <Text size="xs" c="dimmed">Target {formatDateTime(attempt?.targetAt)}</Text>
      {!compact && <><Text size="xs" c="dimmed">Evidence through {formatDateTime(attempt?.dataThroughAt)}</Text><Text size="xs" c="dimmed">Published {formatDateTime(attempt?.completedAt)}</Text><Text size="xs" c="dimmed">Valid until {formatDateTime(attempt?.validUntil)}</Text>{attempt && attempt.status !== "VALID" && <Text size="sm" c="red">Latest attempt {attempt.status.toLowerCase()}: {attempt.reasonCode ? label(attempt.reasonCode) : "No reason recorded"}</Text>}{summary.latestValid && summary.latestValid.id !== attempt?.id && <Text size="xs" c="dimmed">Last valid target: {formatDateTime(summary.latestValid.targetAt)} (historical context only)</Text>}</>}
    </Stack>
  </Card>;
}

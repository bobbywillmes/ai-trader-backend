import { Accordion, Card, Group, Stack, Text } from "@mantine/core";
import { StatusBadge } from "../../components/data-display";
import { assessmentFreshness, formatDateTime, freshnessTone, label, stateExplanation } from "./presentation";
import type { DimensionKey, DimensionSummary } from "./types";
import classes from "./MarketIntelligencePage.module.css";
export function DimensionSummaryCard({ dimension, title, summary, compact = false }: { dimension: DimensionKey; title: string; summary: DimensionSummary; compact?: boolean }) {
  const attempt = summary.latestAttempt; const freshness = assessmentFreshness(attempt);
  return <Card className={classes.card} withBorder p={compact ? "sm" : "md"}>
    <Stack gap="sm"><Group justify="space-between" align="flex-start"><Text fw={700}>{title}</Text><StatusBadge status={freshness} tone={freshnessTone(freshness)} size="compact" /></Group>
      <div><Text className={classes.state} fw={800}>{attempt?.effectiveState ? label(attempt.effectiveState) : "Unavailable"}</Text><Text size="sm" c="dimmed" mt={6}>{stateExplanation(dimension, attempt?.effectiveState ?? null)}</Text></div>
      <Group gap="xs"><StatusBadge status={attempt?.status ?? "NOT_PUBLISHED"} tone={!attempt ? "neutral" : attempt.status === "VALID" ? "positive" : attempt.status === "FAILED" ? "danger" : "warning"} size="compact" /><Text size="sm" fw={600}>Target {attempt?.sessionDate?.slice(0, 10) ?? formatDateTime(attempt?.targetAt)}</Text></Group>
      <Text size="sm" c="dimmed">Evidence through {formatDateTime(attempt?.dataThroughAt)}</Text>
      {attempt && attempt.status !== "VALID" && <Text size="sm" c="red">{attempt.reasonCode ? label(attempt.reasonCode) : "No failure reason recorded"}</Text>}
      {!compact && <Accordion variant="separated"><Accordion.Item value="technical"><Accordion.Control>Assessment details</Accordion.Control><Accordion.Panel><Stack gap="xs"><Text size="sm">Raw state: <b>{attempt?.rawState ? label(attempt.rawState) : "Unavailable"}</b></Text><Text size="sm">Published: {formatDateTime(attempt?.completedAt)}</Text><Text size="sm">Valid until: {formatDateTime(attempt?.validUntil)}</Text><Text size="sm">{summary.algorithmVersion} · evidence schema {attempt?.evidenceSchemaVersion ?? "—"} · attempt {attempt?.attempt ?? "—"}</Text>{summary.latestValid && summary.latestValid.id !== attempt?.id && <Text size="sm" c="dimmed">Last valid target: {formatDateTime(summary.latestValid.targetAt)}. Historical context only; it is not the current assessment.</Text>}</Stack></Accordion.Panel></Accordion.Item></Accordion>}
    </Stack>
  </Card>;
}

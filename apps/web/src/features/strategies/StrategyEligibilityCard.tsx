import { Alert, Badge, Card, Group, Stack, Text, Title } from "@mantine/core";
import { StatusBadge } from "../../components/data-display";
import { formatDateTime, label } from "../marketIntelligence/presentation";
import { useCurrentStrategyEligibility } from "./hooks";

export function StrategyEligibilityCard({ strategyId, token }: { strategyId: number; token: string | null }) {
  const query = useCurrentStrategyEligibility(strategyId, token); const current = query.data;
  return <Card withBorder><Stack><Group justify="space-between"><Group gap="xs"><Title order={3} size="h4">Current market eligibility</Title><Badge color="grape">Shadow only</Badge></Group>{current?.assessment && <StatusBadge status={current.assessment.outcome} tone={current.assessment.outcome === "ALLOWED" ? "positive" : current.assessment.outcome === "BLOCKED" ? "danger" : "warning"} />}</Group>
    <Text size="sm" c="dimmed">Informational policy evidence only. An ALLOWED result does not authorize a signal, order, or trade.</Text>
    {query.isError ? <Alert color="red">{query.error.message}</Alert> : query.isLoading ? <Text>Loading shadow result…</Text> : !current?.assessment ? <Alert color="yellow">No recorded shadow decision is available.</Alert> : <Group><Text size="sm"><b>Reason:</b> {label(current.assessment.reasonCode)}</Text><Text size="sm"><b>Freshness:</b> {label(current.freshness)}</Text><Text size="sm"><b>Evaluated:</b> {formatDateTime(current.assessment.evaluatedAt)}</Text><Text size="sm"><b>Policy:</b> revision {current.assessment.policyRevision?.revision ?? "none"}</Text></Group>}
  </Stack></Card>;
}

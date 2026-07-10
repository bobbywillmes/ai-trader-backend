import { Badge, Card, Group, Stack, Text, Title } from "@mantine/core";
import { useParams } from "react-router-dom";

import { MomentumScannerNavigation } from "./MomentumScannerNavigation";

function ResearchRouteShell({
  title,
  description,
  eyebrow,
}: {
  title: string;
  description: string;
  eyebrow: string;
}) {
  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />
      <Stack gap="xs">
        <Group gap="xs">
          <Badge variant="light">Research only</Badge>
          <Badge color="gray" variant="light">
            No automatic entries
          </Badge>
        </Group>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
          {eyebrow}
        </Text>
        <Title order={1}>{title}</Title>
        <Text c="dimmed" maw={760}>
          {description}
        </Text>
      </Stack>
      <Card withBorder radius="md" p="lg">
        <Text c="dimmed">
          This route is established for the momentum research interface. Its research
          content will be added in the next focused UI changes.
        </Text>
      </Card>
    </Stack>
  );
}

export function MomentumResearchDashboardPage() {
  return (
    <ResearchRouteShell
      eyebrow="Momentum Scanner"
      title="Momentum Research"
      description="Review active catalyst-backed momentum opportunities and understand why the scanner is interested in each symbol."
    />
  );
}

export function MomentumCandidatesPage() {
  return (
    <ResearchRouteShell
      eyebrow="Research candidates"
      title="Momentum Candidates"
      description="Browse and filter the scanner's stored momentum candidates."
    />
  );
}

export function MomentumCandidateDetailPage() {
  const { candidateId } = useParams();
  return (
    <ResearchRouteShell
      eyebrow="Candidate case file"
      title={`Candidate ${candidateId ?? ""}`.trim()}
      description="Review the candidate's stored score, catalyst, price checks, and prepared handoffs."
    />
  );
}

export function MomentumCatalystsPage() {
  return (
    <ResearchRouteShell
      eyebrow="Catalyst research"
      title="Catalyst Events"
      description="Browse meaningful news and catalyst events observed by the scanner."
    />
  );
}

export function MomentumSymbolResearchPage() {
  const { symbol } = useParams();
  return (
    <ResearchRouteShell
      eyebrow="Symbol research"
      title={(symbol ?? "Symbol").toUpperCase()}
      description="Review the scanner's current research, candidate, catalyst, and trading context for this symbol."
    />
  );
}

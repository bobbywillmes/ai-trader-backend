import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { IconArrowRight, IconExternalLink } from "@tabler/icons-react";
import { Link } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useLatestMomentumPipelineRuns, useMomentumResearchOverview } from "./hooks";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import { MomentumPipelineRunSummary } from "./components/MomentumPipelineRunSummary";
import type {
  MomentumCandidateState,
  MomentumResearchCandidateRow,
  MomentumResearchOverview,
} from "./types";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatRelative(value: string | null | undefined) {
  if (!value) return "Not available";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Not available";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function stateColor(state: MomentumCandidateState) {
  if (state === "ENTRY_READY") return "teal";
  if (state === "ENTRY_BLOCKED") return "red";
  if (state === "WATCHING") return "blue";
  if (state === "DISCOVERED") return "cyan";
  return "gray";
}

function sentimentColor(sentiment: string) {
  if (sentiment === "POSITIVE") return "teal";
  if (sentiment === "NEGATIVE") return "red";
  if (sentiment === "MIXED") return "yellow";
  return "gray";
}

function SummaryCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Card withBorder radius="md" p="md">
      <Text size="xs" fw={700} c="dimmed" tt="uppercase">
        {label}
      </Text>
      <Text size="xl" fw={800} c={color}>
        {value.toLocaleString()}
      </Text>
    </Card>
  );
}

function Score({ value, label }: { value: number; label: string }) {
  return (
    <Stack gap={0} align="flex-end">
      <Text fw={800}>{value}</Text>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
    </Stack>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <Text c="dimmed" py="md">
      {children}
    </Text>
  );
}

function TopCandidates({ rows }: { rows: MomentumResearchCandidateRow[] }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between">
          <div>
            <Title order={3}>Top candidates</Title>
            <Text size="sm" c="dimmed">
              Active opportunities ranked by stored total score.
            </Text>
          </div>
          <Group gap="xs"><Badge color="gray" variant="light">{rows.length.toLocaleString()}</Badge><Button component={Link} to="/momentum-scanner/candidates" variant="subtle" rightSection={<IconArrowRight size={15} />}>Browse all</Button></Group>
        </Group>
        {rows.length === 0 ? (
          <EmptyState>No active momentum opportunities are currently stored.</EmptyState>
        ) : (
          <ScrollArea.Autosize mah={460} type="auto" offsetScrollbars>
            <Table highlightOnHover miw={960} stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Symbol</Table.Th><Table.Th>State</Table.Th><Table.Th ta="right">Total</Table.Th>
                  <Table.Th ta="right">Catalyst</Table.Th><Table.Th ta="right">Price</Table.Th>
                  <Table.Th ta="right">Volume</Table.Th><Table.Th ta="right">Risk</Table.Th>
                  <Table.Th>Latest check</Table.Th><Table.Th>Handoff</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.id}>
                    <Table.Td>
                      <Anchor component={Link} to={`/momentum-scanner/symbols/${encodeURIComponent(row.symbol)}`} fw={800}>{row.symbol}</Anchor>
                      <Anchor component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(row.id)}`} display="block" size="xs">View candidate</Anchor>
                      {row.blockedReason && <Text size="xs" c="red" lineClamp={1}>{row.blockedReason}</Text>}
                    </Table.Td>
                    <Table.Td><Badge color={stateColor(row.state)} variant="light">{row.state.replaceAll("_", " ")}</Badge></Table.Td>
                    <Table.Td><Score value={row.scores.total} label="total" /></Table.Td>
                    <Table.Td><Score value={row.scores.catalyst} label={row.catalyst?.eventType ?? "catalyst"} /></Table.Td>
                    <Table.Td ta="right">{row.scores.priceAction ?? <Text size="xs" c="dimmed">Not evaluated</Text>}</Table.Td>
                    <Table.Td ta="right">{row.scores.volume ?? <Text size="xs" c="dimmed">Not evaluated</Text>}</Table.Td>
                    <Table.Td ta="right">{row.scores.risk ?? <Text size="xs" c="dimmed">Not evaluated</Text>}</Table.Td>
                    <Table.Td title={formatDate(row.latestPriceCheck?.observedAt)}>{formatRelative(row.latestPriceCheck?.observedAt)}</Table.Td>
                    <Table.Td>{row.latestHandoff ? <Badge variant="outline">{row.latestHandoff.status}</Badge> : <Text size="sm" c="dimmed">None</Text>}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        )}
      </Stack>
    </Card>
  );
}

function RecentCatalysts({ data }: { data: MomentumResearchOverview["recentCatalysts"] }) {
  return (
    <Card withBorder radius="md" p="lg">
      <Stack gap="md">
        <Group justify="space-between"><Title order={3}>Recent catalysts</Title><Badge color="gray" variant="light">{data.length.toLocaleString()}</Badge></Group>
        {data.length === 0 ? <EmptyState>No catalyst events were received in the last 24 hours.</EmptyState> : <ScrollArea.Autosize mah={600} type="auto" offsetScrollbars>{data.map((event) => (
          <Stack key={event.id} gap={5} pb="sm" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
            <Group justify="space-between" align="flex-start" wrap="nowrap">
              <div>
                <Group gap={6} mb={4}>
                  {event.impactedSymbols.slice(0, 3).map((symbol) => <Anchor key={symbol} component={Link} to={`/momentum-scanner/symbols/${encodeURIComponent(symbol)}`} fw={800} size="sm">{symbol}</Anchor>)}
                  {event.impactedSymbols.length > 3 && <Text size="xs" c="dimmed">+{event.impactedSymbols.length - 3}</Text>}
                </Group>
                <Text fw={600} lineClamp={2}>{event.title}</Text>
                <Text size="xs" c="dimmed">Published {formatDate(event.publishedAt)} · Received {formatDate(event.receivedAt)} · {event.sourcePublisher ?? event.source}</Text>
              </div>
              {event.sourceUrl && <Button component="a" href={event.sourceUrl} target="_blank" rel="noreferrer" size="compact-xs" variant="subtle" aria-label="Open source article"><IconExternalLink size={15} /></Button>}
            </Group>
            <Group gap="xs"><Badge variant="light">{event.eventType.replaceAll("_", " ")}</Badge><Badge variant="outline">{event.eventTier}</Badge><Badge color={sentimentColor(event.sentiment)} variant="light">{event.sentiment}</Badge><Badge color={event.candidateCount > 0 ? "blue" : "gray"} variant="dot">{event.candidateCount} candidate{event.candidateCount === 1 ? "" : "s"}</Badge></Group>
          </Stack>
        ))}</ScrollArea.Autosize>}
      </Stack>
    </Card>
  );
}

export function MomentumResearchDashboardPage() {
  const token = getAdminToken();
  const overview = useMomentumResearchOverview(token);
  const pipelineRuns = useLatestMomentumPipelineRuns(token);
  const data = overview.data;

  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />
      <Group justify="space-between" align="flex-end">
        <div>
          <Group gap="xs" mb="xs"><Badge variant="light">Research only</Badge><Badge color="gray" variant="light">No automatic entries</Badge><Badge color="gray" variant="light">No orders created</Badge></Group>
          <Title order={1}>Momentum Research</Title>
          <Text c="dimmed" maw={760}>Review active catalyst-backed momentum opportunities and understand why the scanner is interested in each symbol.</Text>
        </div>
        {overview.isFetching && <Loader size="sm" />}
      </Group>

      {overview.isError && <Alert color="red" title="Unable to load momentum research">{overview.error instanceof Error ? overview.error.message : "The research overview could not be loaded."}</Alert>}
      {pipelineRuns.isError && <Alert color="red" title="Unable to load pipeline status">{pipelineRuns.error instanceof Error ? pipelineRuns.error.message : "Pipeline status could not be loaded."}</Alert>}
      <MomentumPipelineRunSummary run={pipelineRuns.data?.latestAttempt ?? null} />

      {data && (
        <>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
            <SummaryCard label="Active candidates" value={data.summary.activeCandidates} color="blue" />
            <SummaryCard label="Entry ready" value={data.summary.entryReadyCandidates} color="teal" />
            <SummaryCard label="Entry blocked" value={data.summary.blockedCandidates} color="red" />
            <SummaryCard label="Recent catalysts" value={data.summary.recentCatalysts} />
            <SummaryCard label="Prepared handoffs" value={data.summary.preparedHandoffs} />
            <SummaryCard label="Research universe" value={data.summary.enabledUniverseMembers} />
          </SimpleGrid>
          <Card withBorder radius="md" p="lg">
            <Stack gap="md">
              <Group justify="space-between">
                <div>
                  <Title order={3}>Eligibility and configuration health</Title>
                  <Text size="sm" c="dimmed">Research inclusion and momentum trading ownership are evaluated separately.</Text>
                </div>
                <Button component={Link} to="/momentum-scanner/universe" variant="subtle" size="compact-sm">Open universe</Button>
              </Group>
              <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
                <SummaryCard label="Research universe" value={data.eligibilitySummary.universeMembersEnabled} />
                <SummaryCard label="Momentum eligible" value={data.eligibilitySummary.universeMembersWithActiveMomentumSubscriptions} color="teal" />
                <SummaryCard label="Research only" value={data.eligibilitySummary.researchOnlyMembers} color={data.eligibilitySummary.researchOnlyMembers ? "yellow" : undefined} />
                <SummaryCard label="Subscription mismatch" value={data.eligibilitySummary.enabledMomentumSubscriptionsOutsideUniverse} color={data.eligibilitySummary.enabledMomentumSubscriptionsOutsideUniverse ? "orange" : undefined} />
                <SummaryCard label="Price eligible" value={data.eligibilitySummary.priceConfirmationEligibleCandidates} color="blue" />
                <SummaryCard label="Handoff eligible" value={data.eligibilitySummary.handoffEligibleCandidates} color="violet" />
              </SimpleGrid>
              {(data.eligibilitySummary.activeCandidatesOutsideUniverse > 0 || data.eligibilitySummary.activeCandidatesWithoutValidSecurities > 0 || data.eligibilitySummary.staleCandidatesAwaitingExpiration > 0) && (
                <Alert color="orange" title="Candidate configuration needs attention">
                  {data.eligibilitySummary.activeCandidatesOutsideUniverse} outside the universe; {data.eligibilitySummary.activeCandidatesWithoutValidSecurities} without a valid security; {data.eligibilitySummary.staleCandidatesAwaitingExpiration} stale.
                </Alert>
              )}
              {(data.eligibilitySummary.bounded.securitiesTruncated || data.eligibilitySummary.bounded.candidatesTruncated) && <Text size="xs" c="dimmed">Diagnostics reached the {data.eligibilitySummary.bounded.limit.toLocaleString()}-record safety limit.</Text>}
            </Stack>
          </Card>
          <TopCandidates rows={data.topCandidates} />
          <SimpleGrid cols={{ base: 1, xl: 2 }}>
            <RecentCatalysts data={data.recentCatalysts} />
            <Stack gap="lg">
              <Card withBorder radius="md" p="lg">
                <Stack gap="md"><Group justify="space-between"><Title order={3}>Recently updated candidates</Title><Badge color="gray" variant="light">{data.recentCandidateActivity.length.toLocaleString()}</Badge></Group>{data.recentCandidateActivity.length === 0 ? <EmptyState>No candidates were evaluated or updated in the last 24 hours.</EmptyState> : <ScrollArea.Autosize mah={460} type="auto" offsetScrollbars>{data.recentCandidateActivity.map((candidate) => <Group key={candidate.id} justify="space-between" wrap="nowrap"><div><Anchor component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(candidate.id)}`} fw={700}>{candidate.symbol}</Anchor><Text size="xs" c="dimmed" lineClamp={1}>{candidate.reason ?? "No stored explanation."}</Text></div><Stack gap={2} align="flex-end"><Badge color={stateColor(candidate.state)} variant="light">{candidate.state.replaceAll("_", " ")}</Badge><Text size="xs" c="dimmed" title={formatDate(candidate.activityAt)}>{formatRelative(candidate.activityAt)}</Text></Stack></Group>)}</ScrollArea.Autosize>}</Stack>
              </Card>
              <Card withBorder radius="md" p="lg">
                <Stack gap="md"><Group justify="space-between"><Title order={3}>Scanner health</Title><Button component={Link} to="/momentum-scanner/pipeline" variant="subtle" size="compact-sm">Open pipeline</Button></Group><SimpleGrid cols={2}><SummaryCard label="Healthy cursors" value={data.scannerHealth.healthyCursorCount} color="teal" /><SummaryCard label="Error cursors" value={data.scannerHealth.errorCursorCount} color={data.scannerHealth.errorCursorCount ? "red" : undefined} /><SummaryCard label="Due cursors" value={data.scannerHealth.dueCursorCount} /><SummaryCard label="Enabled cursors" value={data.scannerHealth.enabledCursorCount} /></SimpleGrid><Stack gap={4}><Text size="sm">Last news pull: <b>{formatDate(data.scannerHealth.lastNewsPullAt)}</b></Text><Text size="sm">Last candidate activity: <b>{formatDate(data.scannerHealth.lastCandidateGenerationActivityAt)}</b></Text><Text size="sm">Last price confirmation: <b>{formatDate(data.scannerHealth.lastPriceConfirmationActivityAt)}</b></Text></Stack></Stack>
              </Card>
            </Stack>
          </SimpleGrid>
        </>
      )}
    </Stack>
  );
}

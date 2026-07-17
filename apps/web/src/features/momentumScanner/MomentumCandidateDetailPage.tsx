import {
  Accordion, Alert, Badge, Button, Card, Code, Divider, Group, Loader,
  ScrollArea, SimpleGrid, Stack, Table, Text, Title,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { MomentumMarketChart } from "./components/MomentumMarketChart";
import { useMomentumMarketChart, useMomentumResearchCandidate } from "./hooks";
import { momentumCandidateChartRange, recommendedMarketChartInterval } from "./marketChartRange";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import type { MomentumCandidateState, MomentumMarketChartInterval } from "./types";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatNumber(value: string | number | null | undefined, suffix = "") {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function yesNo(value: boolean | null | undefined) {
  return value === null || value === undefined ? "-" : value ? "Yes" : "No";
}

function stateColor(state: MomentumCandidateState) {
  if (state === "ENTRY_READY") return "teal";
  if (state === "ENTRY_BLOCKED") return "red";
  if (state === "WATCHING") return "blue";
  if (state === "DISCOVERED") return "cyan";
  return "gray";
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <Stack gap={2}><Text size="xs" fw={700} c="dimmed" tt="uppercase">{label}</Text><Text size="sm">{value}</Text></Stack>;
}

function HistoryHeading({ title, count }: { title: string; count: number }) {
  return <Group justify="space-between"><Title order={2}>{title}</Title><Badge color="gray" variant="light">{count.toLocaleString()}</Badge></Group>;
}

function ScoreCard({ label, value, evaluated = true, maximum = 100 }: { label: string; value: number; evaluated?: boolean; maximum?: number }) {
  return <Card withBorder radius="md" p="md"><Text size="xs" fw={700} c="dimmed" tt="uppercase">{label}</Text><Text size="xl" fw={800} c={evaluated ? undefined : "dimmed"}>{evaluated ? `${value}/${maximum}` : "Not evaluated"}</Text></Card>;
}

function JsonValue({ value }: { value: unknown }) {
  return value === null || value === undefined ? <Text c="dimmed">No data recorded.</Text> : <Code block style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(value, null, 2)}</Code>;
}

function freshnessInputs(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function MomentumCandidateDetailPage() {
  const { candidateId } = useParams();
  const token = getAdminToken();
  const detail = useMomentumResearchCandidate(token, candidateId ?? null);
  const data = detail.data;
  const [chartInterval, setChartInterval] = useState<MomentumMarketChartInterval>("1m");
  const initializedCandidate = useRef<string | null>(null);

  useEffect(() => {
    if (data && initializedCandidate.current !== data.candidate.id) {
      initializedCandidate.current = data.candidate.id;
      setChartInterval(recommendedMarketChartInterval(data.candidate));
    }
  }, [data]);

  const chartRange = useMemo(
    () => data ? momentumCandidateChartRange(data.candidate, chartInterval) : undefined,
    [chartInterval, data]
  );
  const chartQuery = useMemo(() => ({
    interval: chartInterval,
    candidateId: candidateId ?? undefined,
    from: chartRange?.from,
    to: chartRange?.to,
  }), [candidateId, chartInterval, chartRange]);
  const chart = useMomentumMarketChart(token, data?.candidate.symbol ?? null, chartQuery);

  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />
      {detail.isLoading && <Group><Loader size="sm" /><Text c="dimmed">Loading candidate case file…</Text></Group>}
      {detail.isError && <Alert color="red" title="Unable to load candidate">{detail.error instanceof Error ? detail.error.message : "The candidate case file could not be loaded."}</Alert>}
      {data && (() => {
        const candidate = data.candidate;
        const catalyst = candidate.catalystEvent;
        const impact = candidate.catalystImpact;
        const latestCheck = candidate.priceChecks.at(-1) ?? null;
        const freshness = freshnessInputs(latestCheck?.scoringInputs);
        const awaitingData = latestCheck?.decision === "WATCHING" &&
          String(latestCheck.blockedReason ?? "").startsWith("AWAITING_");
        const latestHandoff = candidate.scannerHandoffs.at(-1) ?? null;
        return <>
          <Card withBorder radius="md" p="lg"><Stack gap="md"><Group justify="space-between"><Title order={2}>Eligibility</Title><Badge color={data.eligibility.momentumSubscriptionEligibility.eligible ? "teal" : "yellow"} variant="light">{data.eligibility.momentumSubscriptionEligibility.eligible ? "Momentum enabled" : "Research only"}</Badge></Group><SimpleGrid cols={{ base: 1, sm: 2 }}><Info label="Price confirmation" value={data.eligibility.priceConfirmationEligible ? "Eligible" : `Blocked — ${data.eligibility.priceConfirmationReasons.join(", ").replaceAll("_", " ").toLowerCase()}`} /><Info label="Handoff" value={data.eligibility.handoffEligible ? "Eligible" : `Blocked — ${data.eligibility.handoffReasons.join(", ").replaceAll("_", " ").toLowerCase()}`} /></SimpleGrid><Text size="xs" c="dimmed">Configuration eligibility is separate from the stored candidate state. Handoff eligibility does not approve or submit an order.</Text></Stack></Card>
          <Group justify="space-between" align="flex-start">
            <div>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase">Candidate case file</Text>
              <Group gap="sm"><Title order={1}>{candidate.symbol}</Title><Badge color={stateColor(candidate.state)} size="lg" variant="light">{candidate.state.replaceAll("_", " ")}</Badge></Group>
              <Text c="dimmed">{data.security?.name ?? "Security details unavailable"}</Text>
            </div>
            <Button component={Link} to={`/momentum-scanner/symbols/${encodeURIComponent(candidate.symbol)}`} variant="light">Open symbol research</Button>
          </Group>

          <Card withBorder radius="md" p="lg"><SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
            <Info label="Total score" value={<Text fw={800}>{candidate.totalScore}</Text>} />
            <Info label="Discovered" value={formatDate(candidate.discoveredAt)} />
            <Info label="Latest evaluation" value={formatDate(candidate.lastEvaluatedAt)} />
            <Info label="Latest price check" value={formatDate(latestCheck?.observedAt)} />
            <Info label="Entry status" value={candidate.state === "ENTRY_READY" ? "Entry ready" : candidate.state === "ENTRY_BLOCKED" ? "Entry blocked" : "Not entry ready"} />
            <Info label="Handoff" value={latestHandoff?.status ?? "Not prepared"} />
          </SimpleGrid>{awaitingData && <Alert color="yellow" title="Awaiting fresh market data" mt="md">The latest evaluation is incomplete; the setup is not blocked.</Alert>}{candidate.state === "ENTRY_BLOCKED" && candidate.blockedReason && <Alert color="red" title="Blocked reason" mt="md">{candidate.blockedReason}</Alert>}</Card>

          <MomentumMarketChart
            data={chart.data}
            candidate
            interval={chartInterval}
            onIntervalChange={setChartInterval}
            isLoading={chart.isLoading}
            isFetching={chart.isFetching}
            error={chart.error instanceof Error ? chart.error : null}
            title="Decision-linked market context"
          />

          <Stack gap="sm"><Title order={2}>Score breakdown</Title><SimpleGrid cols={{ base: 2, sm: 5 }}><ScoreCard label="Catalyst" value={candidate.catalystScore} maximum={90} /><ScoreCard label="Price action" value={candidate.priceActionScore} evaluated={Boolean(latestCheck)} /><ScoreCard label="Volume" value={candidate.volumeScore} evaluated={Boolean(latestCheck)} /><ScoreCard label="Setup quality" value={candidate.riskScore} evaluated={Boolean(latestCheck)} /><ScoreCard label="Total" value={candidate.totalScore} maximum={96} /></SimpleGrid><Text size="sm" c="dimmed">Versioned checks persist formal score ranges. Setup quality is stored in the legacy riskScore field; higher means a cleaner market setup.</Text></Stack>

          <Card withBorder radius="md" p="lg"><Stack gap="md"><Group justify="space-between"><Title order={2}>Latest confirmation decision</Title>{latestCheck && <Badge variant="light">{latestCheck.scoringVersion ?? "Legacy / unversioned"}</Badge>}</Group>{!latestCheck ? <Text c="dimmed">Not evaluated. No stored price confirmation exists.</Text> : <><SimpleGrid cols={{ base: 1, sm: 3 }}><Info label="Decision" value={latestCheck.decision.replaceAll("_", " ")} /><Info label="Confirmed" value={latestCheck.confirmed ? "Yes" : "No"} /><Info label="Hard block" value={latestCheck.blockedReason?.replaceAll("_", " ") ?? "None"} /></SimpleGrid><SimpleGrid cols={{ base: 1, sm: 3 }}><Info label="Market observation" value={formatDate(typeof freshness?.marketObservationAt === "string" ? freshness.marketObservationAt : null)} /><Info label="Observation age" value={typeof freshness?.marketObservationAgeSeconds === "number" ? `${formatNumber(freshness.marketObservationAgeSeconds)} seconds` : "Not available"} /><Info label="Allowed age" value={typeof freshness?.maxAllowedAgeSeconds === "number" ? `${formatNumber(freshness.maxAllowedAgeSeconds)} seconds` : "Not available"} /><Info label="Market session" value={String(freshness?.marketSession ?? "Not available").replaceAll("_", " ")} /><Info label="Observation source" value={String(freshness?.marketObservationSource ?? "Not available").replaceAll("_", " ")} /></SimpleGrid>{latestCheck.scoreExplanation ? <Accordion variant="contained"><Accordion.Item value="explanation"><Accordion.Control>Versioned explanation and score ranges</Accordion.Control><Accordion.Panel><JsonValue value={latestCheck.scoreExplanation} /></Accordion.Panel></Accordion.Item><Accordion.Item value="inputs"><Accordion.Control>Inputs evaluated</Accordion.Control><Accordion.Panel><JsonValue value={latestCheck.scoringInputs} /></Accordion.Panel></Accordion.Item></Accordion> : <Text c="dimmed">Legacy check — no separate stored explanation.</Text>}</>}</Stack></Card>

          <Card withBorder radius="md" p="lg"><Stack gap="md"><Group justify="space-between"><Title order={2}>Catalyst</Title>{catalyst?.sourceUrl && <Button component="a" href={catalyst.sourceUrl} target="_blank" rel="noreferrer" variant="subtle" rightSection={<IconExternalLink size={15} />}>Open source</Button>}</Group>{catalyst ? <><Title order={3}>{catalyst.title}</Title><Text c="dimmed">{catalyst.summary ?? "No catalyst summary recorded."}</Text><SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}><Info label="Publisher" value={catalyst.sourcePublisher ?? catalyst.source} /><Info label="Published" value={formatDate(catalyst.publishedAt)} /><Info label="Received" value={formatDate(catalyst.receivedAt)} /><Info label="Type" value={catalyst.eventType.replaceAll("_", " ")} /><Info label="Tier" value={catalyst.eventTier} /><Info label="Sentiment" value={catalyst.sentiment} /><Info label="Ticker role" value={impact?.catalystRole?.replaceAll("_", " ") ?? "Not recorded"} /><Info label="Catalyst score" value={impact?.totalCatalystScore ?? candidate.catalystScore} /></SimpleGrid><Divider /><Stack gap={4}><Text size="xs" fw={700} c="dimmed" tt="uppercase">Stored relevance and scoring reasoning</Text><Text>{impact?.sentimentReasoning ?? candidate.reason ?? "No stored reasoning available."}</Text></Stack></> : <Text c="dimmed">This candidate no longer has a linked catalyst event.</Text>}</Stack></Card>

          <Card withBorder radius="md" p="lg"><Stack gap="md"><HistoryHeading title="Price-check history" count={candidate.priceChecks.length} />{candidate.priceChecks.length === 0 ? <Text c="dimmed">No stored price or volume checks are available.</Text> : <ScrollArea.Autosize mah={460} type="auto" offsetScrollbars><Table striped miw={1180} stickyHeader><Table.Thead><Table.Tr><Table.Th>Observed</Table.Th><Table.Th ta="right">Price</Table.Th><Table.Th ta="right">Change</Table.Th><Table.Th ta="right">VWAP</Table.Th><Table.Th>Above VWAP</Table.Th><Table.Th ta="right">Volume</Table.Th><Table.Th ta="right">RVOL</Table.Th><Table.Th ta="right">Price score</Table.Th><Table.Th ta="right">Volume score</Table.Th><Table.Th>Confirmed</Table.Th><Table.Th>Reason</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{candidate.priceChecks.map((check) => <Table.Tr key={check.id}><Table.Td>{formatDate(check.observedAt)}</Table.Td><Table.Td ta="right">{formatNumber(check.lastPrice)}</Table.Td><Table.Td ta="right">{formatNumber(check.pctFromPreviousClose, "%")}</Table.Td><Table.Td ta="right">{formatNumber(check.sessionVwap)}</Table.Td><Table.Td>{yesNo(check.aboveVwap)}</Table.Td><Table.Td ta="right">{formatNumber(check.dayVolume)}</Table.Td><Table.Td ta="right">{formatNumber(check.relativeVolume)}</Table.Td><Table.Td ta="right">{check.priceActionScore}</Table.Td><Table.Td ta="right">{check.volumeScore}</Table.Td><Table.Td><Badge color={check.confirmed ? "teal" : "gray"} variant="light">{check.confirmed ? "Yes" : "No"}</Badge></Table.Td><Table.Td maw={280}><Text size="sm" lineClamp={2}>{check.blockedReason ?? check.decision ?? "No reason recorded"}</Text></Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea.Autosize>}</Stack></Card>

          <Card withBorder radius="md" p="lg"><Stack gap="md"><Title order={2}>Prepared handoffs</Title><Alert color="blue" variant="light">A scanner handoff is a stored review payload. It is not an order and does not prove broker submission.</Alert>{candidate.scannerHandoffs.length === 0 ? <Text c="dimmed">No handoff has been prepared for this candidate.</Text> : <ScrollArea type="auto"><Table miw={820}><Table.Thead><Table.Tr><Table.Th>Prepared</Table.Th><Table.Th>Status</Table.Th><Table.Th>Version</Table.Th><Table.Th>Sent</Table.Th><Table.Th>Acknowledged</Table.Th><Table.Th ta="right">Attempts</Table.Th><Table.Th>Error</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{candidate.scannerHandoffs.map((handoff) => <Table.Tr key={handoff.id}><Table.Td>{formatDate(handoff.preparedAt)}</Table.Td><Table.Td><Badge variant="light">{handoff.status}</Badge></Table.Td><Table.Td>{handoff.payloadVersion}</Table.Td><Table.Td>{formatDate(handoff.sentAt)}</Table.Td><Table.Td>{formatDate(handoff.acknowledgedAt)}</Table.Td><Table.Td ta="right">{handoff.attempts}</Table.Td><Table.Td>{handoff.lastError ?? "-"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>}</Stack></Card>

          <Accordion variant="separated"><Accordion.Item value="candidate-reason"><Accordion.Control>Stored candidate explanation</Accordion.Control><Accordion.Panel><Text>{candidate.reason ?? "No explanation recorded."}</Text></Accordion.Panel></Accordion.Item><Accordion.Item value="snapshot"><Accordion.Control>Raw candidate snapshot</Accordion.Control><Accordion.Panel><JsonValue value={candidate.rawSnapshot} /></Accordion.Panel></Accordion.Item><Accordion.Item value="metadata"><Accordion.Control>Candidate metadata</Accordion.Control><Accordion.Panel><JsonValue value={candidate.metadata} /></Accordion.Panel></Accordion.Item></Accordion>
        </>;
      })()}
      {!detail.isLoading && !data && !detail.isError && <Text c="dimmed">No candidate selected.</Text>}
    </Stack>
  );
}

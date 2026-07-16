import { Alert, Anchor, Badge, Button, Card, Divider, Group, Loader, ScrollArea, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { MomentumMarketChart } from "./components/MomentumMarketChart";
import { useMomentumMarketChart, useMomentumSymbolResearch } from "./hooks";
import { momentumCandidateChartRange, recommendedMarketChartInterval } from "./marketChartRange";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import type { MomentumCandidateState, MomentumMarketChartInterval, MomentumResearchCandidateDetail } from "./types";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatNumber(value: string | number | null | undefined, suffix = "") {
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}` : String(value);
}

function stateColor(state: MomentumCandidateState) {
  if (state === "ENTRY_READY") return "teal";
  if (state === "ENTRY_BLOCKED") return "red";
  if (state === "WATCHING") return "blue";
  if (state === "DISCOVERED") return "cyan";
  return "gray";
}

function sentimentColor(value: string) {
  if (value === "POSITIVE") return "teal";
  if (value === "NEGATIVE") return "red";
  if (value === "MIXED") return "yellow";
  return "gray";
}

function StatusBadge({ active, activeLabel, inactiveLabel, color = "teal" }: { active: boolean; activeLabel: string; inactiveLabel: string; color?: string }) {
  return <Badge color={active ? color : "gray"} variant="light">{active ? activeLabel : inactiveLabel}</Badge>;
}

function ScoreCard({ label, value, reasoning }: { label: string; value: number; reasoning?: string | null }) {
  return <Card withBorder radius="md" p="md"><Text size="xs" fw={700} c="dimmed" tt="uppercase">{label}</Text><Text size="xl" fw={800}>{value}</Text><Text size="xs" c="dimmed" lineClamp={3}>{reasoning ?? "No separate stored explanation."}</Text></Card>;
}

function CandidateSummary({ candidate }: { candidate: MomentumResearchCandidateDetail["candidate"] }) {
  const latestCheck = candidate.priceChecks.at(-1) ?? null;
  const latestHandoff = candidate.scannerHandoffs.at(-1) ?? null;
  return <Card withBorder radius="md" p="lg"><Stack gap="md"><Group justify="space-between"><div><Title order={2}>Current candidate</Title><Text c="dimmed">{candidate.reason ?? "No stored explanation."}</Text></div><Badge color={stateColor(candidate.state)} size="lg" variant="light">{candidate.state.replaceAll("_", " ")}</Badge></Group><SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }}><ScoreCard label="Total" value={candidate.totalScore} /><ScoreCard label="Catalyst" value={candidate.catalystScore} /><ScoreCard label="Price" value={candidate.priceActionScore} /><ScoreCard label="Volume" value={candidate.volumeScore} /><ScoreCard label="Risk" value={candidate.riskScore} /><Stack gap={2}><Text size="xs" fw={700} c="dimmed" tt="uppercase">Latest check</Text><Text size="sm">{formatDate(latestCheck?.observedAt)}</Text><Text size="xs" c="dimmed">{latestCheck?.decision ?? "No check"}</Text></Stack><Stack gap={2}><Text size="xs" fw={700} c="dimmed" tt="uppercase">Handoff</Text><Text size="sm">{latestHandoff?.status ?? "Not prepared"}</Text></Stack></SimpleGrid>{candidate.blockedReason && <Alert color="red" title="Blocked reason">{candidate.blockedReason}</Alert>}<Group justify="flex-end"><Button component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(candidate.id)}`} variant="light">Open candidate case file</Button></Group></Stack></Card>;
}

export function MomentumSymbolResearchPage() {
  const { symbol: routeSymbol } = useParams();
  const symbol = routeSymbol?.toUpperCase() ?? null;
  const token = getAdminToken();
  const research = useMomentumSymbolResearch(token, symbol);
  const data = research.data;
  const [chartInterval, setChartInterval] = useState<MomentumMarketChartInterval>("1m");
  const initializedContext = useRef<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const context = `${data.security.symbol}:${data.currentCandidate?.id ?? "current-session"}`;
    if (initializedContext.current !== context) {
      initializedContext.current = context;
      setChartInterval(data.currentCandidate
        ? recommendedMarketChartInterval(data.currentCandidate)
        : "1m");
    }
  }, [data]);

  const chartRange = useMemo(
    () => data?.currentCandidate
      ? momentumCandidateChartRange(data.currentCandidate, chartInterval)
      : undefined,
    [chartInterval, data]
  );
  const chartQuery = useMemo(() => ({
    interval: chartInterval,
    candidateId: data?.currentCandidate?.id,
    from: chartRange?.from,
    to: chartRange?.to,
  }), [chartInterval, chartRange, data?.currentCandidate?.id]);
  const chart = useMomentumMarketChart(token, data?.security.symbol ?? null, chartQuery);

  return <Stack gap="lg"><MomentumScannerNavigation />
    {research.isLoading && <Group><Loader size="sm" /><Text c="dimmed">Loading symbol research…</Text></Group>}
    {research.isError && <Alert color="red" title="Unable to load symbol research">{research.error instanceof Error ? research.error.message : "Symbol research could not be loaded."}</Alert>}
    {data && <>
      <Stack gap="xs"><Text size="xs" fw={700} c="dimmed" tt="uppercase">Symbol research</Text><Group justify="space-between" align="flex-start"><div><Title order={1}>{data.security.symbol}</Title><Text c="dimmed">{data.security.name} · {data.security.assetType}</Text></div><Group gap="xs" maw={760} justify="flex-end"><StatusBadge active={data.researchStatus.universeMember} activeLabel="In research universe" inactiveLabel="Not in universe" color="blue" /><StatusBadge active={data.researchStatus.newsEnabled} activeLabel="News enabled" inactiveLabel="News disabled" color="cyan" /><StatusBadge active={data.researchStatus.priceScanningEnabled} activeLabel="Price scanning" inactiveLabel="Price scanning off" color="violet" /><StatusBadge active={data.tradingContext.hasEnabledSubscription} activeLabel="Tradable subscription" inactiveLabel="No enabled subscription" /><StatusBadge active={data.tradingContext.hasOpenPosition} activeLabel="Open position" inactiveLabel="No open position" color="orange" />{data.currentCandidate && <Badge color={stateColor(data.currentCandidate.state)} variant="light">{data.currentCandidate.state.replaceAll("_", " ")}</Badge>}</Group></Group></Stack>

      <Group gap="xs"><StatusBadge active={data.eligibility.momentumSubscriptionEligibility.eligible} activeLabel="Active momentum subscription" inactiveLabel="Research only" /><StatusBadge active={data.eligibility.candidateEligibility.priceConfirmationEligible} activeLabel="Price confirmation eligible" inactiveLabel="Price confirmation blocked" color="blue" /><StatusBadge active={data.eligibility.candidateEligibility.handoffEligible} activeLabel="Handoff eligible" inactiveLabel="Handoff ineligible" color="violet" /></Group>

      {data.currentCandidate ? <CandidateSummary candidate={data.currentCandidate} /> : <Card withBorder radius="md" p="lg"><Title order={2}>No current momentum candidate</Title><Text c="dimmed">The scanner has no active stored candidate for this symbol. Historical research remains available below.</Text></Card>}

      <MomentumMarketChart
        data={chart.data}
        candidate={Boolean(data.currentCandidate)}
        interval={chartInterval}
        onIntervalChange={setChartInterval}
        isLoading={chart.isLoading}
        isFetching={chart.isFetching}
        error={chart.error instanceof Error ? chart.error : null}
        title="Market context"
      />

      <Card withBorder radius="md" p="lg"><Stack gap="md"><Title order={2}>Eligibility</Title><SimpleGrid cols={{ base: 1, md: 3 }}><div><Text fw={700}>Research eligibility</Text><Text size="sm" c={data.eligibility.researchEligibility.eligible ? "teal" : "dimmed"}>{data.eligibility.researchEligibility.eligible ? "Eligible" : `Blocked — ${data.eligibility.researchEligibility.reasons.join(", ").replaceAll("_", " ").toLowerCase()}`}</Text></div><div><Text fw={700}>Price confirmation</Text><Text size="sm" c={data.eligibility.candidateEligibility.priceConfirmationEligible ? "teal" : "dimmed"}>{data.eligibility.candidateEligibility.priceConfirmationEligible ? "Eligible" : `Blocked — ${data.eligibility.candidateEligibility.priceConfirmationReasons.join(", ").replaceAll("_", " ").toLowerCase()}`}</Text></div><div><Text fw={700}>Handoff</Text><Text size="sm" c={data.eligibility.candidateEligibility.handoffEligible ? "teal" : "dimmed"}>{data.eligibility.candidateEligibility.handoffEligible ? "Eligible" : `Blocked — ${data.eligibility.candidateEligibility.handoffReasons.join(", ").replaceAll("_", " ").toLowerCase()}`}</Text></div></SimpleGrid><Text size="xs" c="dimmed">{data.eligibility.momentumSubscriptionEligibility.qualifyingSubscriptionIds.length} qualifying momentum subscription{data.eligibility.momentumSubscriptionEligibility.qualifyingSubscriptionIds.length === 1 ? "" : "s"}. Handoff eligibility does not approve or submit an order.</Text></Stack></Card>

      {data.currentCandidate && <Stack gap="sm"><Title order={2}>Score explanation</Title><SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}><ScoreCard label="Catalyst score" value={data.currentCandidate.catalystScore} reasoning={data.currentCandidate.catalystImpact?.sentimentReasoning ?? data.currentCandidate.reason} /><ScoreCard label="Price action score" value={data.currentCandidate.priceActionScore} reasoning={data.currentCandidate.priceChecks.at(-1)?.decision} /><ScoreCard label="Volume score" value={data.currentCandidate.volumeScore} reasoning={data.currentCandidate.priceChecks.at(-1)?.metadata ? "Stored confirmation metadata is available in the candidate case file." : null} /><ScoreCard label="Risk score" value={data.currentCandidate.riskScore} reasoning={data.currentCandidate.blockedReason} /></SimpleGrid></Stack>}

      <SimpleGrid cols={{ base: 1, xl: 2 }}><Card withBorder radius="md" p="lg"><Stack gap="md"><Title order={2}>Recent catalyst timeline</Title>{data.recentCatalysts.length === 0 ? <Text c="dimmed">No stored catalyst events affect this symbol.</Text> : data.recentCatalysts.map((event) => { const impact = event.tickerImpacts[0]; const candidate = event.momentumCandidates[0]; return <Stack key={event.id} gap={5} pb="md" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}><Group justify="space-between" wrap="nowrap"><div><Text size="xs" c="dimmed">Published {formatDate(event.publishedAt)} · Received {formatDate(event.receivedAt)}</Text><Text fw={700}>{event.title}</Text><Text size="sm" c="dimmed">{event.sourcePublisher ?? event.source}</Text></div>{event.sourceUrl && <Button component="a" href={event.sourceUrl} target="_blank" rel="noreferrer" variant="subtle" size="compact-sm"><IconExternalLink size={15} /></Button>}</Group><Group gap="xs"><Badge variant="light">{event.eventType.replaceAll("_", " ")}</Badge><Badge variant="outline">{event.eventTier}</Badge><Badge color={sentimentColor(event.sentiment)} variant="light">{event.sentiment}</Badge>{impact?.catalystRole && <Badge color="gray" variant="light">{impact.catalystRole.replaceAll("_", " ")}</Badge>}</Group>{impact?.sentimentReasoning && <Text size="sm">{impact.sentimentReasoning}</Text>}{candidate && <Anchor component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(candidate.id)}`} size="sm">Candidate {candidate.state.replaceAll("_", " ")} · score {candidate.totalScore}</Anchor>}</Stack>; })}</Stack></Card>

      <Card withBorder radius="md" p="lg"><Stack gap="md"><Title order={2}>Research versus trading context</Title><Stack gap="sm"><div><Text fw={700}>Research universe</Text><Text size="sm" c="dimmed">{data.researchStatus.universeMember ? `Member; ${data.researchStatus.universeEnabled ? "enabled" : "disabled"}. News ${data.researchStatus.newsEnabled ? "enabled" : "disabled"}; price scanning ${data.researchStatus.priceScanningEnabled ? "enabled" : "disabled"}.` : "No explicit momentum universe membership."}</Text></div><Divider /><div><Text fw={700}>News cursor</Text><Text size="sm" c="dimmed">Health: {data.researchStatus.cursorHealth ?? "No cursor"}. Last pull: {formatDate(data.researchStatus.lastNewsPullAt)}.</Text></div><Divider /><div><Text fw={700}>Subscriptions</Text>{data.tradingContext.subscriptions.length === 0 ? <Text size="sm" c="dimmed">No related trading subscriptions.</Text> : data.tradingContext.subscriptions.map((subscription) => <Group key={subscription.id} justify="space-between"><Text size="sm">{subscription.name} · {subscription.broker} {subscription.brokerMode}</Text><Badge color={subscription.enabled ? "teal" : "gray"} variant="light">{subscription.enabled ? "Enabled" : "Disabled"}</Badge></Group>)}</div><Divider /><div><Text fw={700}>Open or closing positions</Text>{data.tradingContext.openPositions.length === 0 ? <Text size="sm" c="dimmed">No open or closing tracked position.</Text> : data.tradingContext.openPositions.map((position) => <Text key={position.id} size="sm">{position.status.toUpperCase()} · {formatNumber(position.qty)} shares · {formatNumber(position.unrealizedPnLPct, "%")} unrealized</Text>)}</div></Stack></Stack></Card></SimpleGrid>

      <Card withBorder radius="md" p="lg"><Stack gap="md"><Title order={2}>Stored price-check history</Title>{data.priceChecks.length === 0 ? <Text c="dimmed">No stored price checks are available for recent candidates.</Text> : <ScrollArea type="auto"><Table striped miw={920}><Table.Thead><Table.Tr><Table.Th>Observed</Table.Th><Table.Th ta="right">Price</Table.Th><Table.Th ta="right">Change</Table.Th><Table.Th ta="right">VWAP</Table.Th><Table.Th ta="right">Volume</Table.Th><Table.Th ta="right">RVOL</Table.Th><Table.Th>Confirmed</Table.Th><Table.Th>Decision</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{data.priceChecks.map((check) => <Table.Tr key={check.id}><Table.Td>{formatDate(check.observedAt)}</Table.Td><Table.Td ta="right">{formatNumber(check.lastPrice)}</Table.Td><Table.Td ta="right">{formatNumber(check.pctFromPreviousClose, "%")}</Table.Td><Table.Td ta="right">{formatNumber(check.sessionVwap)}</Table.Td><Table.Td ta="right">{formatNumber(check.dayVolume)}</Table.Td><Table.Td ta="right">{formatNumber(check.relativeVolume)}</Table.Td><Table.Td><Badge color={check.confirmed ? "teal" : "gray"} variant="light">{check.confirmed ? "Yes" : "No"}</Badge></Table.Td><Table.Td>{check.blockedReason ?? check.decision ?? "-"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>}</Stack></Card>

      <Card withBorder radius="md" p="lg"><Stack gap="md"><Title order={2}>Candidate history</Title>{data.recentCandidates.length === 0 ? <Text c="dimmed">No momentum candidates have been stored for this symbol.</Text> : <ScrollArea type="auto"><Table highlightOnHover miw={900}><Table.Thead><Table.Tr><Table.Th>Created</Table.Th><Table.Th>State</Table.Th><Table.Th ta="right">Total</Table.Th><Table.Th>Catalyst</Table.Th><Table.Th>Latest check</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{data.recentCandidates.map((candidate) => <Table.Tr key={candidate.id}><Table.Td><Anchor component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(candidate.id)}`}>{formatDate(candidate.discoveredAt)}</Anchor></Table.Td><Table.Td><Badge color={stateColor(candidate.state)} variant="light">{candidate.state.replaceAll("_", " ")}</Badge></Table.Td><Table.Td ta="right" fw={800}>{candidate.totalScore}</Table.Td><Table.Td maw={300}><Text size="sm" lineClamp={2}>{candidate.catalystEvent?.title ?? "No linked catalyst"}</Text></Table.Td><Table.Td>{formatDate(candidate.priceChecks.at(-1)?.observedAt)}</Table.Td><Table.Td>{candidate.blockedReason ?? candidate.scannerHandoffs.at(-1)?.status ?? "No handoff"}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>}</Stack></Card>
    </>}
  </Stack>;
}

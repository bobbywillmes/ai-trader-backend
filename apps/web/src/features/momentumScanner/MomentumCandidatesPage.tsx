import { useMemo, useState } from "react";
import {
  Alert, Anchor, Badge, Button, Card, Group, Loader, NumberInput, Pagination,
  ScrollArea, Select, SimpleGrid, Stack, Table, Text, TextInput, Title,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowRight, IconRefresh } from "@tabler/icons-react";
import { Link } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useMomentumResearchCandidates } from "./hooks";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import type { MomentumCandidateState, MomentumResearchCandidatesQuery } from "./types";

const states: MomentumCandidateState[] = ["DISCOVERED", "WATCHING", "ENTRY_READY", "ENTRY_BLOCKED", "EXPIRED", "DISMISSED"];
const catalystTypes = ["EARNINGS", "GUIDANCE", "ANALYST_UPGRADE", "FDA_REGULATORY", "CONTRACT_WIN", "PARTNERSHIP", "ACQUISITION_MERGER", "INDEX_ADDITION", "SEC_FILING", "PRODUCT_LAUNCH", "MACRO_MARKET", "SECTOR_THEME", "UNKNOWN"];

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function stateColor(state: MomentumCandidateState) {
  if (state === "ENTRY_READY") return "teal";
  if (state === "ENTRY_BLOCKED") return "red";
  if (state === "WATCHING") return "blue";
  if (state === "DISCOVERED") return "cyan";
  return "gray";
}

export function MomentumCandidatesPage() {
  const token = getAdminToken();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const [state, setState] = useState<string | null>(null);
  const [minimum, setMinimum] = useState<number | string>("");
  const [catalystType, setCatalystType] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<string | null>("lastEvaluatedAt:desc");
  const query = useMemo<MomentumResearchCandidatesQuery>(() => {
    const [sortBy, sortDirection] = (sort ?? "lastEvaluatedAt:desc").split(":") as [MomentumResearchCandidatesQuery["sortBy"], "asc" | "desc"];
    return {
      page, pageSize: 25, sortBy, sortDirection,
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
      ...(state ? { state: state as MomentumCandidateState } : {}),
      ...(typeof minimum === "number" ? { minTotalScore: minimum } : {}),
      ...(catalystType ? { catalystType } : {}),
      ...(readiness === "ready" ? { entryReady: true } : readiness === "blocked" ? { blocked: true } : {}),
      ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
      ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}),
    };
  }, [catalystType, debouncedSearch, from, minimum, page, readiness, sort, state, to]);
  const result = useMomentumResearchCandidates(token, query);
  const data = result.data;

  function reset() {
    setSearch(""); setState(null); setMinimum(""); setCatalystType(null); setReadiness(null); setFrom(""); setTo(""); setSort("lastEvaluatedAt:desc"); setPage(1);
  }

  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />
      <Group justify="space-between" align="flex-end">
        <div><Text size="xs" fw={700} c="dimmed" tt="uppercase">Momentum research</Text><Title order={1}>Candidates</Title><Text c="dimmed">Filter and review stored momentum opportunities without changing scanner state.</Text></div>
        {result.isFetching && <Loader size="sm" />}
      </Group>
      <Card withBorder radius="md" p="md">
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            <TextInput label="Symbol" placeholder="AAPL" value={search} onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }} />
            <Select label="State" clearable data={states.map((value) => ({ value, label: value.replaceAll("_", " ") }))} value={state} onChange={(value) => { setState(value); setPage(1); }} />
            <NumberInput label="Minimum total score" min={0} value={minimum} onChange={(value) => { setMinimum(value); setPage(1); }} />
            <Select label="Catalyst type" clearable searchable data={catalystTypes.map((value) => ({ value, label: value.replaceAll("_", " ") }))} value={catalystType} onChange={(value) => { setCatalystType(value); setPage(1); }} />
            <Select label="Readiness" clearable data={[{ value: "ready", label: "Entry ready" }, { value: "blocked", label: "Entry blocked" }]} value={readiness} onChange={(value) => { setReadiness(value); setPage(1); }} />
            <TextInput type="date" label="Discovered from" value={from} onChange={(event) => { setFrom(event.currentTarget.value); setPage(1); }} />
            <TextInput type="date" label="Discovered through" value={to} onChange={(event) => { setTo(event.currentTarget.value); setPage(1); }} />
            <Select label="Sort" data={[{ value: "lastEvaluatedAt:desc", label: "Recently evaluated" }, { value: "updatedAt:desc", label: "Recently updated" }, { value: "discoveredAt:desc", label: "Recently discovered" }, { value: "totalScore:desc", label: "Highest score" }, { value: "symbol:asc", label: "Symbol A–Z" }]} value={sort} onChange={(value) => { setSort(value); setPage(1); }} />
          </SimpleGrid>
          <Group justify="space-between"><Text size="sm" c="dimmed">{data ? `${data.pagination.total.toLocaleString()} candidates` : "Loading candidates…"}</Text><Button variant="subtle" size="compact-sm" leftSection={<IconRefresh size={14} />} onClick={reset}>Reset filters</Button></Group>
        </Stack>
      </Card>
      {result.isError && <Alert color="red" title="Unable to load candidates">{result.error instanceof Error ? result.error.message : "Candidate research could not be loaded."}</Alert>}
      {data && data.data.length > 0 && <Card withBorder radius="md" p="md"><Stack gap="sm"><Text size="xs" fw={700} c="dimmed" tt="uppercase">Eligibility on this page</Text>{data.data.map((row) => <Group key={row.id} justify="space-between" wrap="nowrap"><Anchor component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(row.id)}`} fw={700}>{row.symbol}</Anchor><Group gap="xs" justify="flex-end"><Badge color={row.eligibility.momentumSubscriptionEligibility.eligible ? "teal" : "yellow"} variant="light">{row.eligibility.momentumSubscriptionEligibility.eligible ? "Momentum enabled" : "Research only"}</Badge><Badge color={row.eligibility.priceConfirmationEligible ? "blue" : "gray"} variant="light">{row.eligibility.priceConfirmationEligible ? "Price eligible" : row.eligibility.priceConfirmationReasons[0]?.replaceAll("_", " ") ?? "Price blocked"}</Badge><Badge color={row.eligibility.handoffEligible ? "violet" : "gray"} variant="light">{row.eligibility.handoffEligible ? "Handoff eligible" : "Handoff ineligible"}</Badge></Group></Group>)}</Stack></Card>}
      <Card withBorder radius="md" p={0}>
        {!result.isLoading && data?.data.length === 0 ? <Text c="dimmed" p="lg">No candidates match these filters. Clear filters or wait for the scanner to identify another opportunity.</Text> : (
          <ScrollArea type="auto"><Table striped highlightOnHover miw={1120}><Table.Thead><Table.Tr><Table.Th>Symbol</Table.Th><Table.Th>State</Table.Th><Table.Th ta="right">Total</Table.Th><Table.Th ta="right">Catalyst</Table.Th><Table.Th ta="right">Price</Table.Th><Table.Th ta="right">Volume</Table.Th><Table.Th ta="right">Risk</Table.Th><Table.Th>Headline</Table.Th><Table.Th>Latest check</Table.Th><Table.Th>Updated</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{data?.data.map((row) => <Table.Tr key={row.id}><Table.Td><Anchor component={Link} to={`/momentum-scanner/symbols/${encodeURIComponent(row.symbol)}`} fw={800}>{row.symbol}</Anchor><Text size="xs" c="dimmed">{row.security?.name ?? "Security details unavailable"}</Text></Table.Td><Table.Td><Badge color={stateColor(row.state)} variant="light">{row.state.replaceAll("_", " ")}</Badge>{row.blockedReason && <Text size="xs" c="red" maw={180} lineClamp={2}>{row.blockedReason}</Text>}</Table.Td><Table.Td ta="right" fw={800}>{row.scores.total}</Table.Td><Table.Td ta="right">{row.scores.catalyst}</Table.Td><Table.Td ta="right">{row.scores.priceAction}</Table.Td><Table.Td ta="right">{row.scores.volume}</Table.Td><Table.Td ta="right">{row.scores.risk}</Table.Td><Table.Td maw={320}><Text size="sm" lineClamp={2}>{row.catalyst?.title ?? "No linked catalyst headline"}</Text><Text size="xs" c="dimmed">{row.catalyst?.eventType.replaceAll("_", " ") ?? "-"}</Text></Table.Td><Table.Td>{formatDate(row.latestPriceCheck?.observedAt)}</Table.Td><Table.Td>{formatDate(row.activityAt)}</Table.Td><Table.Td><Button component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(row.id)}`} variant="subtle" size="compact-sm" rightSection={<IconArrowRight size={14} />}>Open</Button></Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>
        )}
      </Card>
      {data && data.pagination.totalPages > 1 && <Group justify="flex-end"><Pagination value={data.pagination.page} total={data.pagination.totalPages} onChange={setPage} /></Group>}
    </Stack>
  );
}

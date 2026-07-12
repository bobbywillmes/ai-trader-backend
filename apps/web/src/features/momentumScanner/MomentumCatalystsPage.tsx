import { useMemo, useState } from "react";
import { Alert, Anchor, Badge, Button, Card, Group, Loader, Pagination, ScrollArea, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconExternalLink, IconRefresh } from "@tabler/icons-react";
import { Link } from "react-router-dom";

import { getAdminToken } from "../../lib/api";
import { useMomentumResearchCatalysts } from "./hooks";
import { MomentumScannerNavigation } from "./MomentumScannerNavigation";
import type { MomentumResearchCatalystsQuery } from "./types";

const sources = ["MASSIVE_NEWS", "MASSIVE_BENZINGA", "SEC_EDGAR", "COMPANY_IR", "MANUAL"];
const catalystTypes = ["EARNINGS", "GUIDANCE", "ANALYST_UPGRADE", "ANALYST_DOWNGRADE", "FDA_REGULATORY", "CONTRACT_WIN", "PARTNERSHIP", "ACQUISITION_MERGER", "INDEX_ADDITION", "INDEX_REMOVAL", "INSIDER_BUYING", "INSIDER_SELLING", "OFFERING_DILUTION", "SEC_FILING", "PRODUCT_LAUNCH", "MACRO_MARKET", "SECTOR_THEME", "OPINION_ANALYSIS", "UNKNOWN"];

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function sentimentColor(value: string) {
  if (value === "POSITIVE") return "teal";
  if (value === "NEGATIVE") return "red";
  if (value === "MIXED") return "yellow";
  return "gray";
}

export function MomentumCatalystsPage() {
  const token = getAdminToken();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [publisher, setPublisher] = useState("");
  const [debouncedSearch] = useDebouncedValue(search, 250);
  const [debouncedPublisher] = useDebouncedValue(publisher, 250);
  const [source, setSource] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [tier, setTier] = useState<string | null>(null);
  const [sentiment, setSentiment] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<string | null>("publishedAt:desc");
  const query = useMemo<MomentumResearchCatalystsQuery>(() => {
    const [sortBy, sortDirection] = (sort ?? "publishedAt:desc").split(":") as [MomentumResearchCatalystsQuery["sortBy"], "asc" | "desc"];
    return { page, pageSize: 25, sortBy, sortDirection, ...(debouncedSearch ? { search: debouncedSearch } : {}), ...(debouncedPublisher ? { publisher: debouncedPublisher } : {}), ...(source ? { source } : {}), ...(type ? { catalystType: type } : {}), ...(tier ? { tier } : {}), ...(sentiment ? { sentiment } : {}), ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}), ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}) };
  }, [debouncedPublisher, debouncedSearch, from, page, sentiment, sort, source, tier, to, type]);
  const result = useMomentumResearchCatalysts(token, query);
  const data = result.data;

  function reset() { setSearch(""); setPublisher(""); setSource(null); setType(null); setTier(null); setSentiment(null); setFrom(""); setTo(""); setSort("publishedAt:desc"); setPage(1); }

  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />
      <Group justify="space-between" align="flex-end"><div><Text size="xs" fw={700} c="dimmed" tt="uppercase">Momentum research</Text><Title order={1}>Catalysts</Title><Text c="dimmed">Browse the news and catalyst events that inform momentum candidates.</Text></div>{result.isFetching && <Loader size="sm" />}</Group>
      <Card withBorder radius="md" p="md"><Stack gap="sm"><SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
        <TextInput label="Symbol or headline" placeholder="AAPL or partnership" value={search} onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }} />
        <TextInput label="Publisher" placeholder="Reuters" value={publisher} onChange={(event) => { setPublisher(event.currentTarget.value); setPage(1); }} />
        <Select label="Source" clearable data={sources.map((value) => ({ value, label: value.replaceAll("_", " ") }))} value={source} onChange={(value) => { setSource(value); setPage(1); }} />
        <Select label="Catalyst type" clearable searchable data={catalystTypes.map((value) => ({ value, label: value.replaceAll("_", " ") }))} value={type} onChange={(value) => { setType(value); setPage(1); }} />
        <Select label="Tier" clearable data={["HIGH", "MEDIUM", "LOW", "IGNORE"]} value={tier} onChange={(value) => { setTier(value); setPage(1); }} />
        <Select label="Sentiment" clearable data={["POSITIVE", "NEGATIVE", "NEUTRAL", "MIXED", "UNKNOWN"]} value={sentiment} onChange={(value) => { setSentiment(value); setPage(1); }} />
        <TextInput type="date" label="Published from" value={from} onChange={(event) => { setFrom(event.currentTarget.value); setPage(1); }} />
        <TextInput type="date" label="Published through" value={to} onChange={(event) => { setTo(event.currentTarget.value); setPage(1); }} />
        <Select label="Sort" data={[{ value: "publishedAt:desc", label: "Newest published" }, { value: "receivedAt:desc", label: "Newest received" }, { value: "updatedAt:desc", label: "Recently updated" }, { value: "publishedAt:asc", label: "Oldest published" }]} value={sort} onChange={(value) => { setSort(value); setPage(1); }} />
      </SimpleGrid><Group justify="space-between"><Text size="sm" c="dimmed">{data ? `${data.pagination.total.toLocaleString()} catalyst events` : "Loading catalysts…"}</Text><Button variant="subtle" size="compact-sm" leftSection={<IconRefresh size={14} />} onClick={reset}>Reset filters</Button></Group></Stack></Card>
      {result.isError && <Alert color="red" title="Unable to load catalysts">{result.error instanceof Error ? result.error.message : "Catalyst research could not be loaded."}</Alert>}
      <Card withBorder radius="md" p={0}>{!result.isLoading && data?.data.length === 0 ? <Text c="dimmed" p="lg">No catalyst events match these filters.</Text> : <ScrollArea type="auto"><Table striped highlightOnHover miw={1050}><Table.Thead><Table.Tr><Table.Th>Published</Table.Th><Table.Th>Symbols</Table.Th><Table.Th>Publisher</Table.Th><Table.Th>Headline</Table.Th><Table.Th>Type</Table.Th><Table.Th>Tier</Table.Th><Table.Th>Sentiment</Table.Th><Table.Th ta="right">Candidates</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{data?.data.map((event) => <Table.Tr key={event.id}><Table.Td><Text size="sm">{formatDate(event.publishedAt)}</Text><Text size="xs" c="dimmed">Received {formatDate(event.receivedAt)}</Text></Table.Td><Table.Td><Group gap={5} maw={180}>{event.impactedSymbols.slice(0, 4).map((symbol) => <Anchor key={symbol} component={Link} to={`/momentum-scanner/symbols/${encodeURIComponent(symbol)}`} size="sm" fw={700}>{symbol}</Anchor>)}{event.impactedSymbols.length > 4 && <Badge size="sm" variant="light">+{event.impactedSymbols.length - 4}</Badge>}</Group></Table.Td><Table.Td>{event.sourcePublisher ?? event.source.replaceAll("_", " ")}</Table.Td><Table.Td maw={380}><Text size="sm" fw={600} lineClamp={2}>{event.title}</Text>{event.momentumCandidates.slice(0, 2).map((candidate) => <Anchor key={candidate.id} component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(candidate.id)}`} display="block" size="xs">{candidate.symbol} candidate</Anchor>)}</Table.Td><Table.Td><Badge variant="light">{event.eventType.replaceAll("_", " ")}</Badge></Table.Td><Table.Td><Badge variant="outline">{event.eventTier}</Badge></Table.Td><Table.Td><Badge color={sentimentColor(event.sentiment)} variant="light">{event.sentiment}</Badge></Table.Td><Table.Td ta="right">{event.candidateCount}</Table.Td><Table.Td>{event.sourceUrl ? <Button component="a" href={event.sourceUrl} target="_blank" rel="noreferrer" variant="subtle" size="compact-sm" rightSection={<IconExternalLink size={14} />}>Source</Button> : <Text size="sm" c="dimmed">-</Text>}</Table.Td></Table.Tr>)}</Table.Tbody></Table></ScrollArea>}</Card>
      {data && data.pagination.totalPages > 1 && <Group justify="flex-end"><Pagination value={data.pagination.page} total={data.pagination.totalPages} onChange={setPage} /></Group>}
    </Stack>
  );
}

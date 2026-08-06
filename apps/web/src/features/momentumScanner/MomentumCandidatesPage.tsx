import { useMemo, useState } from "react";
import { Anchor, Badge, Button, Card, Group, NumberInput, Pagination, Select, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconArrowRight, IconRefresh } from "@tabler/icons-react";
import { Link, useNavigate } from "react-router-dom";

import { CompactRecordList, DataState, DataTable, MobileRecordCard, RecordDetailsGrid, ResponsiveDataView, ResponsiveFilterToolbar, StatusBadge, type ActiveFilter, type SummaryField } from "../../components/data-display";
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

function formatNumber(value: string | number | null | undefined, suffix = "") {
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}` : String(value);
}

export function MomentumCandidatesPage() {
  const navigate = useNavigate();
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
  const [expandedId, setExpandedId] = useState<string | number | null>(null);
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

  const activeFilters: ActiveFilter[] = [
    ...(state ? [{ key: "state", label: state.replaceAll("_", " "), onRemove: () => setState(null) }] : []),
    ...(typeof minimum === "number" ? [{ key: "score", label: `Score ${minimum}+`, onRemove: () => setMinimum("") }] : []),
    ...(catalystType ? [{ key: "catalyst", label: catalystType.replaceAll("_", " "), onRemove: () => setCatalystType(null) }] : []),
    ...(readiness ? [{ key: "readiness", label: readiness === "ready" ? "Entry ready" : "Entry blocked", onRemove: () => setReadiness(null) }] : []),
    ...(from ? [{ key: "from", label: `From ${from}`, onRemove: () => setFrom("") }] : []),
    ...(to ? [{ key: "to", label: `Through ${to}`, onRemove: () => setTo("") }] : []),
  ];
  const fields = (row: NonNullable<typeof data>["data"][number]): SummaryField[] => [
    { label: "Price / move", value: row.latestPriceCheck ? `${formatNumber(row.latestPriceCheck.lastPrice)} · ${formatNumber(row.latestPriceCheck.pctFromPreviousClose, "%")}` : "Not checked" },
    { label: "Score", value: `${row.scores.total} total · ${row.scores.catalyst} catalyst` },
    { label: "Freshness", value: formatDate(row.latestPriceCheck?.observedAt) },
    { label: "Catalyst", value: row.catalyst?.eventType.replaceAll("_", " ") ?? "No linked catalyst" },
  ];
  const identity = (row: NonNullable<typeof data>["data"][number]) => <div><Anchor component={Link} to={`/momentum-scanner/symbols/${encodeURIComponent(row.symbol)}`} fw={800}>{row.symbol}</Anchor><Text size="xs" c="dimmed">{row.security?.name ?? "Security details unavailable"}</Text></div>;
  const status = (row: NonNullable<typeof data>["data"][number]) => <StatusBadge status={row.state} label={row.state.replaceAll("_", " ")} tone={row.state === "ENTRY_READY" ? "positive" : row.state === "ENTRY_BLOCKED" ? "danger" : row.state === "WATCHING" ? "informational" : "neutral"} size="compact" />;
  const details = (row: NonNullable<typeof data>["data"][number]) => <RecordDetailsGrid sections={[{ title: "Candidate", items: [{ label: "Symbol", value: row.symbol }, { label: "State", value: row.state.replaceAll("_", " ") }, ...fields(row), { label: "Evaluated", value: formatDate(row.lastEvaluatedAt) }] }, { title: "Momentum signals", items: [{ label: "Price action", value: row.scores.priceAction ?? "Not evaluated" }, { label: "Volume", value: row.scores.volume ?? "Not evaluated" }, { label: "Setup quality", value: row.scores.risk ?? "Not evaluated" }, { label: "Reason", value: row.blockedReason ?? row.reason ?? "No stored explanation" }] }, { title: "Routing & identifiers", items: [{ label: "Candidate ID", value: row.id, technical: true }, { label: "Security ID", value: row.security?.id ?? "Unavailable", technical: true }] }]} />;
  const wide = (rows: readonly NonNullable<typeof data>["data"][number][]) => <DataTable caption="Momentum candidates" captionHidden density="compact"><Table.Thead><Table.Tr><Table.Th>Candidate</Table.Th><Table.Th>Price / move</Table.Th><Table.Th>Score</Table.Th><Table.Th>Qualification</Table.Th><Table.Th>Catalyst</Table.Th><Table.Th>Freshness</Table.Th><Table.Th>Evaluated</Table.Th><Table.Th /></Table.Tr></Table.Thead><Table.Tbody>{rows.map((row) => <Table.Tr key={row.id}><Table.Td>{identity(row)}</Table.Td><Table.Td>{fields(row)[0].value}</Table.Td><Table.Td fw={700}>{fields(row)[1].value}</Table.Td><Table.Td>{status(row)}{row.blockedReason && <Text size="xs" c="red" maw={220}>{row.blockedReason}</Text>}</Table.Td><Table.Td maw={300}><Text size="sm">{row.catalyst?.title ?? "No linked catalyst"}</Text></Table.Td><Table.Td>{formatDate(row.latestPriceCheck?.observedAt)}</Table.Td><Table.Td>{formatDate(row.activityAt)}</Table.Td><Table.Td><Button component={Link} to={`/momentum-scanner/candidates/${encodeURIComponent(row.id)}`} variant="subtle" size="compact-sm" rightSection={<IconArrowRight size={14} />}>Open</Button></Table.Td></Table.Tr>)}</Table.Tbody></DataTable>;

  return (
    <Stack gap="lg">
      <MomentumScannerNavigation />
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div><Text size="xs" fw={700} c="dimmed" tt="uppercase">Momentum research</Text><Title order={1}>Candidates</Title><Text c="dimmed">Filter and review stored momentum opportunities without changing scanner state.</Text></div>
        <Button leftSection={<IconRefresh size={16} />} variant="default" loading={result.isFetching} onClick={() => void result.refetch()}>Refresh</Button>
      </Group>
      <Card withBorder radius="md" p="md">
        <Stack gap="sm">
          <ResponsiveFilterToolbar title="Candidate filters" primary={<TextInput label="Symbol" placeholder="AAPL" value={search} onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }} />} secondary={<SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label="Symbol" placeholder="AAPL" value={search} onChange={(event) => { setSearch(event.currentTarget.value); setPage(1); }} />
            <Select label="State" clearable data={states.map((value) => ({ value, label: value.replaceAll("_", " ") }))} value={state} onChange={(value) => { setState(value); setPage(1); }} />
            <NumberInput label="Minimum total score" min={0} value={minimum} onChange={(value) => { setMinimum(value); setPage(1); }} />
            <Select label="Catalyst type" clearable searchable data={catalystTypes.map((value) => ({ value, label: value.replaceAll("_", " ") }))} value={catalystType} onChange={(value) => { setCatalystType(value); setPage(1); }} />
            <Select label="Readiness" clearable data={[{ value: "ready", label: "Entry ready" }, { value: "blocked", label: "Entry blocked" }]} value={readiness} onChange={(value) => { setReadiness(value); setPage(1); }} />
            <TextInput type="date" label="Discovered from" value={from} onChange={(event) => { setFrom(event.currentTarget.value); setPage(1); }} />
            <TextInput type="date" label="Discovered through" value={to} onChange={(event) => { setTo(event.currentTarget.value); setPage(1); }} />
            <Select label="Sort" data={[{ value: "lastEvaluatedAt:desc", label: "Recently evaluated" }, { value: "updatedAt:desc", label: "Recently updated" }, { value: "discoveredAt:desc", label: "Recently discovered" }, { value: "totalScore:desc", label: "Highest score" }, { value: "symbol:asc", label: "Symbol A–Z" }]} value={sort} onChange={(value) => { setSort(value); setPage(1); }} />
          </SimpleGrid>} activeFilters={activeFilters} onClearAll={reset} />
          <Group justify="space-between"><Text size="sm" c="dimmed">{data ? `${data.pagination.total.toLocaleString()} candidates` : "Loading candidates…"}</Text><Button variant="subtle" size="compact-sm" leftSection={<IconRefresh size={14} />} onClick={reset}>Reset filters</Button></Group>
        </Stack>
      </Card>
      {result.isError && <DataState state="error" title="Unable to load candidates" message={result.error instanceof Error ? result.error.message : "Candidate research could not be loaded."} onRetry={() => void result.refetch()} />}
      {data && data.data.length > 0 && <Group gap="xs"><Badge color="teal" variant="light">{data.data.filter((row) => row.eligibility.momentumSubscriptionEligibility.eligible).length} momentum enabled</Badge><Badge color="yellow" variant="light">{data.data.filter((row) => !row.eligibility.momentumSubscriptionEligibility.eligible).length} research only</Badge><Badge color="blue" variant="light">{data.data.filter((row) => row.eligibility.priceConfirmationEligible).length} price eligible</Badge><Text size="xs" c="dimmed">Counts reflect this page. Open a candidate for detailed eligibility reasons.</Text></Group>}
      <Card withBorder radius="md" p="md">
        {result.isLoading ? <DataState state="loading" message="Loading candidates…" /> : data?.data.length === 0 ? <DataState state="empty" title={activeFilters.length || search ? "No matching candidates" : "No candidates"} message={activeFilters.length || search ? "No candidates match the current filters." : "Wait for the scanner to identify an opportunity."} action={activeFilters.length || search ? { label: "Clear filters", onClick: reset } : undefined} /> : data && <ResponsiveDataView records={data.data} getRecordId={(row) => row.id} wide={wide} compact={(rows) => <CompactRecordList records={rows} getRecordId={(row) => row.id} renderIdentity={(row) => <Stack gap="xs">{identity(row)}{status(row)}</Stack>} renderFields={fields} renderDetails={details} expandedId={expandedId} onExpandedChange={setExpandedId} />} narrow={(rows) => <MobileRecordCard records={rows} getRecordId={(row) => row.id} renderIdentity={identity} renderStatus={status} renderFields={fields} onDetails={(row) => navigate(`/momentum-scanner/candidates/${encodeURIComponent(row.id)}`)} detailsLabel="View candidate" detailsIsDialog={false} />} aria-label="Momentum candidates" />}
      </Card>
      {data && data.pagination.totalPages > 1 && <Group justify="flex-end"><Pagination value={data.pagination.page} total={data.pagination.totalPages} onChange={setPage} /></Group>}
    </Stack>
  );
}

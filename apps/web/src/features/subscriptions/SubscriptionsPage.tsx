import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert, Badge, Button, Card, Group, Modal, ScrollArea, Select,
  SimpleGrid, Stack, Switch, Table, Text, TextInput, Textarea, Title,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { getAdminToken } from "../../lib/api";
import { useStrategies } from "../strategies/hooks";
import { useExitProfiles } from "../exitProfiles/hooks";
import {
  useCreateSubscription, useSetSubscriptionEnabled, useSubscriptionCatalog,
  useUpdateSubscription,
} from "./hooks";
import type {
  Subscription, SubscriptionAssignmentStatus, SubscriptionCatalogQuery,
  SubscriptionSortBy, SubscriptionSortDirection,
} from "./types";

const PAGE_SIZE_OPTIONS = ["25", "50", "100", "250"];

type Draft = {
  key: string; name: string; description: string; symbol: string;
  strategyId: string | null; exitProfileId: string | null; enabled: boolean;
};

const emptyDraft: Draft = {
  key: "", name: "", description: "", symbol: "",
  strategyId: null, exitProfileId: null, enabled: true,
};

type BooleanFilter = "all" | "true" | "false";

function positiveNumber(params: URLSearchParams, key: string, fallback: number) {
  const value = Number(params.get(key));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function booleanFilter(params: URLSearchParams, key: string): BooleanFilter {
  const value = params.get(key);
  return value === "true" || value === "false" ? value : "all";
}

function optionalId(params: URLSearchParams, key: string) {
  const value = Number(params.get(key));
  return Number.isInteger(value) && value > 0 ? String(value) : null;
}

function toOptionalBoolean(value: BooleanFilter) {
  return value === "all" ? undefined : value === "true";
}

function subscriptionIdFromName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function assignmentState(
  assignments: Subscription["accountSubscriptions"],
  field: "enabled" | "entriesEnabled" | "exitsEnabled"
) {
  if (assignments.length === 0) {
    return { label: "Not assigned", color: "gray" };
  }

  const enabledCount = assignments.filter((assignment) => assignment[field]).length;
  if (assignments.length === 1) {
    return {
      label: enabledCount === 1 ? "Enabled" : "Disabled",
      color: enabledCount === 1 ? "teal" : "gray",
    };
  }

  return {
    label: `${enabledCount} of ${assignments.length}`,
    color: enabledCount === assignments.length ? "teal" : enabledCount === 0 ? "gray" : "yellow",
  };
}

export function SubscriptionsPage() {
  const [params, setParams] = useSearchParams();
  const [token] = useState(() => getAdminToken());
  const [page, setPage] = useState(() => positiveNumber(params, "page", 1));
  const [pageSize, setPageSize] = useState(() => positiveNumber(params, "pageSize", 50));
  const [searchInput, setSearchInput] = useState(() => params.get("search") ?? "");
  const [search, setSearch] = useState(() => params.get("search") ?? "");
  const [globalStatus, setGlobalStatus] = useState<BooleanFilter>(() => booleanFilter(params, "enabled"));
  const [assignmentStatus, setAssignmentStatus] = useState<SubscriptionAssignmentStatus>(() => {
    const value = params.get("assignmentStatus");
    return value === "assigned" || value === "unassigned" ? value : "all";
  });
  const [assignmentEnabled, setAssignmentEnabled] = useState<BooleanFilter>(() => booleanFilter(params, "assignmentEnabled"));
  const [entriesEnabled, setEntriesEnabled] = useState<BooleanFilter>(() => booleanFilter(params, "entriesEnabled"));
  const [exitsEnabled, setExitsEnabled] = useState<BooleanFilter>(() => booleanFilter(params, "exitsEnabled"));
  const [accountId, setAccountId] = useState<string | null>(() => optionalId(params, "tradingAccountId"));
  const [securityId, setSecurityId] = useState<string | null>(() => optionalId(params, "securityId"));
  const [strategyId, setStrategyId] = useState<string | null>(() => optionalId(params, "strategyId"));
  const [exitProfileId, setExitProfileId] = useState<string | null>(() => optionalId(params, "exitProfileId"));
  const [sortBy, setSortBy] = useState<SubscriptionSortBy>(() => {
    const value = params.get("sortBy");
    return value === "name" || value === "symbol" || value === "enabled" ||
      value === "assignmentCount" ? value : "key";
  });
  const [sortDirection, setSortDirection] = useState<SubscriptionSortDirection>(
    () => params.get("sortDirection") === "desc" ? "desc" : "asc"
  );
  const [editing, setEditing] = useState<Subscription | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [autoPopulateId, setAutoPopulateId] = useState(true);

  const query = useMemo<SubscriptionCatalogQuery>(() => ({
    page, pageSize, search: search || undefined,
    enabled: toOptionalBoolean(globalStatus),
    assignmentStatus,
    assignmentEnabled: toOptionalBoolean(assignmentEnabled),
    entriesEnabled: toOptionalBoolean(entriesEnabled),
    exitsEnabled: toOptionalBoolean(exitsEnabled),
    tradingAccountId: accountId ? Number(accountId) : undefined,
    securityId: securityId ? Number(securityId) : undefined,
    strategyId: strategyId ? Number(strategyId) : undefined,
    exitProfileId: exitProfileId ? Number(exitProfileId) : undefined,
    sortBy, sortDirection,
  }), [page, pageSize, search, globalStatus, assignmentStatus,
    assignmentEnabled, entriesEnabled, exitsEnabled, accountId, securityId,
    strategyId, exitProfileId, sortBy, sortDirection]);

  const catalogQuery = useSubscriptionCatalog(query, token);
  const strategiesQuery = useStrategies(token);
  const exitProfilesQuery = useExitProfiles(token);
  const createMutation = useCreateSubscription(token);
  const updateMutation = useUpdateSubscription(token);
  const toggleMutation = useSetSubscriptionEnabled(token);
  const response = catalogQuery.data;
  const rows = response?.data ?? [];
  const pagination = response?.pagination;
  const filters = response?.filters;
  const summary = response?.summary;
  const total = pagination?.total ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const firstResult = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = Math.min(page * pageSize, total);

  useEffect(() => {
    const next = new URLSearchParams();
    if (page !== 1) next.set("page", String(page));
    if (pageSize !== 50) next.set("pageSize", String(pageSize));
    if (search) next.set("search", search);
    if (globalStatus !== "all") next.set("enabled", globalStatus);
    if (assignmentStatus !== "all") next.set("assignmentStatus", assignmentStatus);
    if (assignmentEnabled !== "all") next.set("assignmentEnabled", assignmentEnabled);
    if (entriesEnabled !== "all") next.set("entriesEnabled", entriesEnabled);
    if (exitsEnabled !== "all") next.set("exitsEnabled", exitsEnabled);
    if (accountId) next.set("tradingAccountId", accountId);
    if (securityId) next.set("securityId", securityId);
    if (strategyId) next.set("strategyId", strategyId);
    if (exitProfileId) next.set("exitProfileId", exitProfileId);
    if (sortBy !== "key") next.set("sortBy", sortBy);
    if (sortDirection !== "asc") next.set("sortDirection", sortDirection);
    setParams(next, { replace: true });
  }, [page, pageSize, search, globalStatus, assignmentStatus,
    assignmentEnabled, entriesEnabled, exitsEnabled, accountId, securityId,
    strategyId, exitProfileId, sortBy, sortDirection, setParams]);

  function resetPage() {
    setPage(1);
  }

  function clearFilters() {
    setPage(1); setSearch(""); setSearchInput(""); setGlobalStatus("all");
    setAssignmentStatus("all"); setAssignmentEnabled("all");
    setEntriesEnabled("all"); setExitsEnabled("all"); setAccountId(null);
    setSecurityId(null); setStrategyId(null); setExitProfileId(null);
  }

  function applySummaryFilter(filter: "total" | "enabled" | "retired" | "assigned" | "unassigned") {
    resetPage();
    if (filter === "total") {
      setGlobalStatus("all"); setAssignmentStatus("all");
    } else if (filter === "enabled" || filter === "retired") {
      setGlobalStatus(filter === "enabled" ? "true" : "false");
    } else {
      setAssignmentStatus(filter);
    }
  }

  function handleSort(column: SubscriptionSortBy) {
    resetPage();
    if (sortBy === column) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSortBy(column); setSortDirection("asc"); }
  }

  function sortLabel(column: SubscriptionSortBy) {
    return sortBy === column ? (sortDirection === "asc" ? " (ascending)" : " (descending)") : "";
  }

  function openCreate() {
    setDraft(emptyDraft);
    setAutoPopulateId(true);
    setEditing("new");
  }

  function openEdit(item: Subscription) {
    setDraft({
      key: item.key, name: item.name, description: item.description ?? "",
      symbol: item.security.symbol, strategyId: String(item.strategy.id),
      exitProfileId: String(item.exitProfile.id), enabled: item.enabled,
    });
    setAutoPopulateId(false);
    setEditing(item);
  }

  function updateName(name: string) {
    setDraft((current) => ({
      ...current,
      name,
      key: editing === "new" && autoPopulateId
        ? subscriptionIdFromName(name)
        : current.key,
    }));
  }

  function updateId(key: string) {
    setAutoPopulateId(false);
    setDraft((current) => ({ ...current, key }));
  }

  async function save() {
    if (!draft.key.trim() || !draft.name.trim() || !draft.symbol ||
        !draft.strategyId || !draft.exitProfileId) {
      notifications.show({ color: "red", message: "Complete all required catalog fields." });
      return;
    }
    if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(draft.key.trim())) {
      notifications.show({
        color: "red",
        message: "Subscription ID must use lowercase snake_case, such as aapl_dip_core.",
      });
      return;
    }
    const payload = {
      key: draft.key.trim().toLowerCase(), name: draft.name.trim(),
      description: draft.description.trim() || null, symbol: draft.symbol,
      strategyId: Number(draft.strategyId),
      exitProfileId: Number(draft.exitProfileId), enabled: draft.enabled,
    };
    try {
      if (editing === "new") await createMutation.mutateAsync(payload);
      else if (editing) await updateMutation.mutateAsync({ id: editing.id, payload });
      notifications.show({ color: "teal", message: "Subscription catalog saved." });
      setEditing(null);
    } catch (error) {
      notifications.show({ color: "red", message: error instanceof Error ? error.message : "Save failed." });
    }
  }

  const booleanOptions = [
    { value: "all", label: "All" },
    { value: "true", label: "Enabled" },
    { value: "false", label: "Disabled" },
  ];

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="end">
        <div>
          <Title order={2} size="h3">Subscription Catalog</Title>
          <Text size="sm" c="dimmed">Global trading definitions. Account deployment and sizing are configured on each Trading Account.</Text>
        </div>
        <Button onClick={openCreate}>Create Subscription</Button>
      </Group>

      <SimpleGrid cols={{ base: 2, md: 5 }}>
        {[
          ["Total", summary?.total, "total"],
          ["Globally enabled", summary?.globallyEnabled, "enabled"],
          ["Retired", summary?.globallyRetired, "retired"],
          ["Assigned", summary?.assigned, "assigned"],
          ["Unassigned", summary?.unassigned, "unassigned"],
        ].map(([label, value, filter]) => (
          <Card key={label} withBorder component="button" type="button" onClick={() => applySummaryFilter(filter as "total" | "enabled" | "retired" | "assigned" | "unassigned")} style={{ textAlign: "left", cursor: "pointer" }}>
            <Text size="xs" c="dimmed">{label}</Text>
            <Text fw={700} size="xl">{value ?? "—"}</Text>
          </Card>
        ))}
      </SimpleGrid>

      <Card withBorder>
        <Stack gap="md">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            <TextInput label="Search" placeholder="Key, name, ticker, strategy, exit profile, or description" value={searchInput} onChange={(event) => setSearchInput(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") { resetPage(); setSearch(searchInput.trim()); } }} />
            <Select searchable clearable label="Security" placeholder="All securities" data={(filters?.securities ?? []).map((item) => ({ value: String(item.id), label: `${item.symbol} — ${item.name}` }))} value={securityId} onChange={(value) => { resetPage(); setSecurityId(value); }} />
            <Select searchable clearable label="Strategy" placeholder="All strategies" data={(filters?.strategies ?? []).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.name}` }))} value={strategyId} onChange={(value) => { resetPage(); setStrategyId(value); }} />
            <Select searchable clearable label="Exit Profile" placeholder="All exit profiles" data={(filters?.exitProfiles ?? []).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.name}` }))} value={exitProfileId} onChange={(value) => { resetPage(); setExitProfileId(value); }} />
            <Select label="Catalog status" description="Global availability across every account" data={[{ value: "all", label: "All catalog statuses" }, { value: "true", label: "Globally enabled" }, { value: "false", label: "Retired" }]} value={globalStatus} onChange={(value) => { resetPage(); setGlobalStatus((value ?? "all") as BooleanFilter); }} />
            <Select label="Account assignment" description="Whether the catalog definition is deployed" data={[{ value: "all", label: "Assigned or unassigned" }, { value: "assigned", label: "Assigned" }, { value: "unassigned", label: accountId ? "Not assigned to selected account" : "Unassigned to every account" }]} value={assignmentStatus} onChange={(value) => { resetPage(); setAssignmentStatus((value ?? "all") as SubscriptionAssignmentStatus); }} />
            <Select searchable clearable label="Trading Account" placeholder="All accounts" data={(filters?.tradingAccounts ?? []).map((item) => ({ value: String(item.id), label: `${item.displayName} · ${item.environment}` }))} value={accountId} onChange={(value) => { resetPage(); setAccountId(value); }} />
            <Select label="Assignment master switch" description="Account-level deployment control" data={booleanOptions} value={assignmentEnabled} onChange={(value) => { resetPage(); setAssignmentEnabled((value ?? "all") as BooleanFilter); }} />
            <Select label="Account entries" description="Permission to open new positions" data={booleanOptions} value={entriesEnabled} onChange={(value) => { resetPage(); setEntriesEnabled((value ?? "all") as BooleanFilter); }} />
            <Select label="Account exits" description="Permission to manage or close positions" data={booleanOptions} value={exitsEnabled} onChange={(value) => { resetPage(); setExitsEnabled((value ?? "all") as BooleanFilter); }} />
            <Select label="Rows per page" data={PAGE_SIZE_OPTIONS} value={String(pageSize)} onChange={(value) => { setPage(1); setPageSize(Number(value ?? 50)); }} />
            <Group align="end">
              <Button onClick={() => { resetPage(); setSearch(searchInput.trim()); }}>Apply</Button>
              <Button variant="default" onClick={clearFilters}>Clear</Button>
            </Group>
          </SimpleGrid>

          {catalogQuery.isError && <Alert color="red">{catalogQuery.error.message}</Alert>}
          <ScrollArea>
            <Table striped highlightOnHover miw={1320}>
              <Table.Thead><Table.Tr>
                <Table.Th><Button variant="subtle" size="compact-sm" onClick={() => handleSort("key")}>Definition{sortLabel("key")}</Button></Table.Th>
                <Table.Th><Button variant="subtle" size="compact-sm" onClick={() => handleSort("symbol")}>Security{sortLabel("symbol")}</Button></Table.Th>
                <Table.Th>Strategy</Table.Th><Table.Th>Exit profile</Table.Th>
                <Table.Th><Button variant="subtle" size="compact-sm" onClick={() => handleSort("enabled")}>Catalog status{sortLabel("enabled")}</Button></Table.Th>
                <Table.Th><Button variant="subtle" size="compact-sm" onClick={() => handleSort("assignmentCount")}>Assignments{sortLabel("assignmentCount")}</Button></Table.Th>
                <Table.Th>Master switch</Table.Th>
                <Table.Th>Account entries</Table.Th>
                <Table.Th>Account exits</Table.Th>
                <Table.Th />
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {catalogQuery.isLoading ? (
                  <Table.Tr><Table.Td colSpan={10}><Text c="dimmed">Loading catalog…</Text></Table.Td></Table.Tr>
                ) : rows.length === 0 ? (
                  <Table.Tr><Table.Td colSpan={10}><Text c="dimmed">No catalog entries match these filters.</Text></Table.Td></Table.Tr>
                ) : rows.map((item) => {
                  const displayedAssignments = accountId
                    ? item.accountSubscriptions.filter(
                        (assignment) => assignment.tradingAccount.id === Number(accountId)
                      )
                    : item.accountSubscriptions;
                  const masterState = assignmentState(displayedAssignments, "enabled");
                  const entryState = assignmentState(displayedAssignments, "entriesEnabled");
                  const exitState = assignmentState(displayedAssignments, "exitsEnabled");

                  return <Table.Tr key={item.id}>
                    <Table.Td><Text fw={600}>{item.name}</Text><Text size="xs" ff="monospace">{item.key}</Text></Table.Td>
                    <Table.Td><Text fw={600}>{item.symbol}</Text><Text size="xs" c="dimmed">{item.security.name}</Text></Table.Td>
                    <Table.Td><Text>{item.strategy.name}</Text><Text size="xs" ff="monospace">{item.strategy.key}</Text></Table.Td>
                    <Table.Td><Text>{item.exitProfile.name}</Text><Text size="xs" ff="monospace">{item.exitProfile.key}</Text></Table.Td>
                    <Table.Td><Badge color={item.enabled ? "teal" : "gray"}>{item.enabled ? "Enabled" : "Retired"}</Badge></Table.Td>
                    <Table.Td>
                      <Text size="sm">{displayedAssignments.length} account{displayedAssignments.length === 1 ? "" : "s"}</Text>
                      {displayedAssignments.map((assignment) => (
                        <Text key={assignment.id} size="xs" c="dimmed">{assignment.tradingAccount.displayName}</Text>
                      ))}
                    </Table.Td>
                    <Table.Td><Badge color={masterState.color}>{masterState.label}</Badge></Table.Td>
                    <Table.Td><Badge color={entryState.color}>{entryState.label}</Badge></Table.Td>
                    <Table.Td><Badge color={exitState.color}>{exitState.label}</Badge></Table.Td>
                    <Table.Td><Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button size="xs" variant="subtle" onClick={() => openEdit(item)}>Edit</Button>
                      <Button size="xs" variant="subtle" color={item.enabled ? "orange" : "teal"} loading={toggleMutation.isPending && toggleMutation.variables?.id === item.id} onClick={() => toggleMutation.mutate({ id: item.id, enabled: !item.enabled })}>{item.enabled ? "Retire" : "Enable"}</Button>
                    </Group></Table.Td>
                  </Table.Tr>;
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea>

          <Group justify="space-between">
            <Text size="sm" c="dimmed">Showing {firstResult}-{lastResult} of {total}</Text>
            <Group>
              <Button variant="default" disabled={page <= 1 || catalogQuery.isFetching} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
              <Text size="sm">Page {page} of {totalPages}</Text>
              <Button variant="default" disabled={page >= totalPages || catalogQuery.isFetching} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
            </Group>
          </Group>
        </Stack>
      </Card>

      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Create catalog Subscription" : "Edit catalog Subscription"} size="lg">
        <Stack>
          <Alert color="blue">
            Use a readable name that identifies the security, strategy, and variant,
            such as <strong>AAPL Dip Core</strong>. Its stable ID uses lowercase
            snake_case, such as <strong>aapl_dip_core</strong>.
          </Alert>
          <Group grow align="start">
            <TextInput
              required
              label="Name"
              description="Human-readable catalog name, conventionally: TICKER Strategy Variant"
              placeholder="AAPL Dip Core"
              value={draft.name}
              onChange={(event) => updateName(event.currentTarget.value)}
            />
            <TextInput
              required
              label="ID"
              description={editing === "new" && autoPopulateId
                ? "Generated from the name; edit to override"
                : "Stable, unique snake_case identifier"}
              placeholder="aapl_dip_core"
              value={draft.key}
              onChange={(event) => updateId(event.currentTarget.value)}
            />
          </Group>
          <Select searchable required label="Security" data={(filters?.securities ?? []).map((item) => ({ value: item.symbol, label: `${item.symbol} — ${item.name}` }))} value={draft.symbol || null} onChange={(value) => setDraft({ ...draft, symbol: value ?? "" })} />
          <Group grow>
            <Select searchable required label="Strategy" data={(strategiesQuery.data ?? []).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.name}` }))} value={draft.strategyId} onChange={(value) => setDraft({ ...draft, strategyId: value })} />
            <Select searchable required label="Exit Profile" data={(exitProfilesQuery.data ?? []).map((item) => ({ value: String(item.id), label: `${item.key} — ${item.name}` }))} value={draft.exitProfileId} onChange={(value) => setDraft({ ...draft, exitProfileId: value })} />
          </Group>
          <Textarea label="Description / notes" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.currentTarget.value })} />
          <Switch label="Globally enabled for new entries" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />
          <Alert color="blue">Creating a catalog definition assigns it to zero Trading Accounts.</Alert>
          <Group justify="flex-end"><Button variant="default" onClick={() => setEditing(null)}>Cancel</Button><Button loading={createMutation.isPending || updateMutation.isPending} onClick={save}>Save</Button></Group>
        </Stack>
      </Modal>
    </Stack>
  );
}

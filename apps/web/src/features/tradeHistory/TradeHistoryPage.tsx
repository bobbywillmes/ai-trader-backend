import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Group,
  Pagination,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconRefresh, IconSearch } from "@tabler/icons-react";
import {
  CompactRecordList,
  DataState,
  DataTable,
  MobileRecordCard,
  RecordDetailsGrid,
  ResponsiveDataView,
  ResponsiveFilterToolbar,
  StatusBadge,
  formatStatusLabel,
  type SummaryField,
} from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { TradeCycleDrawer } from "./TradeCycleDrawer";
import {
  formatDate,
  formatDuration,
  formatMoney,
  formatNumber,
  formatPercent,
  pnlColor,
} from "./formatters";
import { useTradeCycleDrawer, useTradeCycles } from "./hooks";
import type { TradeCycleSummary, TradeCyclesQuery } from "./types";
import classes from "./TradeHistoryPage.module.css";
import { TradingAccountScopeSelector } from "../tradingAccountScope/TradingAccountScopeSelector";
import { useTradingAccountScope } from "../tradingAccountScope/useTradingAccountScope";

const signedMoney = (value: number | null) =>
  value !== null && value > 0 ? `+${formatMoney(value)}` : formatMoney(value);
const signedPercent = (value: number | null) =>
  value !== null && value > 0
    ? `+${formatPercent(value)}`
    : formatPercent(value);
const statusTone = (status: string) =>
  status === "closed"
    ? ("neutral" as const)
    : status === "closing"
      ? ("warning" as const)
      : ("informational" as const);
const PAGE_SIZE_OPTIONS = [25, 50, 100];
function Result({ cycle }: { cycle: TradeCycleSummary }) {
  const label =
    cycle.realizedPnl === null
      ? "Result unavailable"
      : cycle.realizedPnl > 0
        ? "Gain"
        : cycle.realizedPnl < 0
          ? "Loss"
          : "Break even";
  return (
    <Stack gap={0}>
      <Text fw={800} c={pnlColor(cycle.realizedPnl)}>
        {signedMoney(cycle.realizedPnl)}{" "}
        <span className={classes.srOnly}>{label}</span>
      </Text>
      <Text size="xs" c={pnlColor(cycle.returnPct)}>
        {signedPercent(cycle.returnPct)} · {label}
      </Text>
    </Stack>
  );
}
function SummaryDetails({ cycle }: { cycle: TradeCycleSummary }) {
  return (
    <RecordDetailsGrid
      sections={[
        {
          title: "Trade result",
          items: [
            { label: "Symbol", value: cycle.symbol },
            {
              label: "Trading account",
              value:
                cycle.tradingAccount?.displayName ??
                `Account ${cycle.tradingAccountId ?? "unlinked"}`,
            },
            { label: "Quantity", value: formatNumber(cycle.quantity) },
            {
              label: "Realized P/L",
              value: `${signedMoney(cycle.realizedPnl)} (${signedPercent(cycle.returnPct)})`,
            },
            {
              label: "Holding duration",
              value: formatDuration(cycle.holdingDurationMs),
            },
            { label: "Status", value: formatStatusLabel(cycle.status) },
          ],
        },
        {
          title: "Entry",
          items: [
            { label: "Average entry", value: formatMoney(cycle.avgEntryPrice) },
            { label: "Opened", value: formatDate(cycle.openedAt) },
            { label: "Strategy", value: cycle.strategy?.name ?? "Not linked" },
            {
              label: "Subscription",
              value: cycle.subscription?.name ?? "Not linked",
            },
            {
              label: "Entry decision",
              value: cycle.entryDecision
                ? formatStatusLabel(cycle.entryDecision.decisionState)
                : "Not linked",
            },
          ],
        },
        {
          title: "Exit",
          items: [
            { label: "Average exit", value: formatMoney(cycle.avgExitPrice) },
            { label: "Closed", value: formatDate(cycle.closedAt) },
            {
              label: "Exit reason",
              value:
                cycle.exitReason ?? cycle.exitStateStatus ?? "Not recorded",
            },
            {
              label: "Exit profile",
              value: cycle.exitProfile?.name ?? "Not linked",
            },
          ],
        },
        {
          title: "Routing & identifiers",
          items: [
            { label: "Trade cycle ID", value: cycle.id, technical: true },
            {
              label: "Trading account ID",
              value: cycle.tradingAccountId,
              technical: true,
            },
            {
              label: "Strategy key",
              value: cycle.strategy?.key,
              technical: true,
            },
            {
              label: "Subscription key",
              value: cycle.subscription?.key,
              technical: true,
            },
          ],
        },
      ]}
    />
  );
}

export function TradeHistoryPage() {
  const [token] = useState(() => getAdminToken());
  const [params, setParams] = useSearchParams();
  const accountScope = useTradingAccountScope();
  const [expanded, setExpanded] = useState<number | null>(null);
  const drawer = useTradeCycleDrawer(token);
  const page = Number(params.get("page")) || 1;
  const pageSize = Number(params.get("pageSize")) || 25;
  const symbol = params.get("symbol") ?? "";
  const [symbolDraft, setSymbolDraft] = useState(symbol);
  const status = params.has("status") ? params.get("status") : "closed";
  const mode = params.get("mode") ?? "all";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const update = (key: string, value: string, fallback = "") =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === fallback || value === "") next.delete(key);
      else next.set(key, value);
      if (key !== "page") next.delete("page");
      return next;
    });
  const setPage = (value: number) => update("page", String(value), "1");
  const setPageSize = (value: number) => update("pageSize", String(value), "25");
  const applyTextFilters = () => update("symbol", symbolDraft.trim());
  const setStatus = (value: string) => update("status", value, "closed");
  const setMode = (value: string) => update("mode", value, "all");
  const setDateFrom = (value: string) => update("dateFrom", value);
  const setDateTo = (value: string) => update("dateTo", value);
  const query = useMemo<TradeCyclesQuery>(
    () => ({
      account: accountScope.isAll ? "all" : accountScope.selectedAccount?.id,
      page,
      pageSize,
      ...(symbol.trim() ? { symbol: symbol.trim().toUpperCase() } : {}),
      ...(status === "open" || status === "closing" || status === "closed"
        ? { status }
        : {}),
      ...(mode !== "all" ? { mode } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    }),
    [
      accountScope.isAll,
      accountScope.selectedAccount?.id,
      dateFrom,
      dateTo,
      page,
      pageSize,
      mode,
      status,
      symbol,
    ],
  );
  const cyclesQuery = useTradeCycles(token, query);
  const cycles = cyclesQuery.data?.cycles ?? [];
  const pagination = cyclesQuery.data?.pagination;
  const clear = () => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const key of ["symbol", "status", "mode", "dateFrom", "dateTo", "page", "pageSize", "limit"]) next.delete(key);
      return next;
    });
    setSymbolDraft("");
  };
  const active = [
    {
      key: "symbol",
      active: Boolean(symbol.trim()),
      label: `Symbol: ${symbol.trim().toUpperCase()}`,
      remove: () => {
        setSymbolDraft("");
        update("symbol", "");
      },
    },
    {
      key: "status",
      active: status !== "closed",
      label: `Status: ${formatStatusLabel(status ?? "closed")}`,
      remove: () => setStatus("closed"),
    },
    {
      key: "mode",
      active: mode !== "all",
      label: `Mode: ${formatStatusLabel(mode)}`,
      remove: () => setMode("all"),
    },
    {
      key: "from",
      active: Boolean(dateFrom),
      label: `From ${dateFrom}`,
      remove: () => setDateFrom(""),
    },
    {
      key: "to",
      active: Boolean(dateTo),
      label: `To ${dateTo}`,
      remove: () => setDateTo(""),
    },
  ]
    .filter((item) => item.active)
    .map((item) => ({
      key: item.key,
      label: item.label,
      onRemove: item.remove,
    }));
  const identity = (cycle: TradeCycleSummary) => (
    <div>
      <Text component="h3" fw={800}>
        {cycle.symbol}
      </Text>
      <Text size="xs" c="dimmed">
        {accountScope.isAll
          ? `${cycle.tradingAccount?.displayName ?? `Account ${cycle.tradingAccountId}`} · ${cycle.tradingAccount?.environment ?? ""} · `
          : ""}
        {cycle.strategy?.name ?? cycle.subscription?.name ?? "Unassigned"}
      </Text>
    </div>
  );
  const fields = (cycle: TradeCycleSummary): SummaryField[] => [
    { label: "Result", value: <Result cycle={cycle} /> },
    {
      label: "Entry → exit",
      value: `${formatMoney(cycle.avgEntryPrice)} → ${formatMoney(cycle.avgExitPrice)}`,
    },
    { label: "Duration", value: formatDuration(cycle.holdingDurationMs) },
    {
      label: "Exit reason",
      value: cycle.exitReason ?? cycle.exitStateStatus ?? "Not recorded",
    },
    { label: "Closed", value: formatDate(cycle.closedAt) },
  ];
  const wide = (items: readonly TradeCycleSummary[]) => (
    <DataTable caption="Trade history" captionHidden density="compact">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Trade</Table.Th>
          <Table.Th>Entry / exit</Table.Th>
          <Table.Th>Result</Table.Th>
          <Table.Th>Duration</Table.Th>
          <Table.Th>Exit reason</Table.Th>
          <Table.Th>Closed</Table.Th>
          <Table.Th>Actions</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((cycle) => (
          <Fragment key={cycle.id}>
            <Table.Tr>
              <Table.Td>
                {identity(cycle)}
                <Badge size="xs" variant="light" mt={4}>
                  {formatNumber(cycle.quantity)} {cycle.side}
                </Badge>
              </Table.Td>
              <Table.Td>
                {formatMoney(cycle.avgEntryPrice)} →{" "}
                {formatMoney(cycle.avgExitPrice)}
              </Table.Td>
              <Table.Td>
                <Result cycle={cycle} />
              </Table.Td>
              <Table.Td>{formatDuration(cycle.holdingDurationMs)}</Table.Td>
              <Table.Td className={classes.reason}>
                {cycle.exitReason ?? cycle.exitStateStatus ?? "Not recorded"}
              </Table.Td>
              <Table.Td>{formatDate(cycle.closedAt)}</Table.Td>
              <Table.Td>
                <Button
                  variant="default"
                  size="compact-sm"
                  aria-expanded={expanded === cycle.id}
                  onClick={() =>
                    setExpanded(expanded === cycle.id ? null : cycle.id)
                  }
                >
                  Details
                </Button>
              </Table.Td>
            </Table.Tr>
            {expanded === cycle.id && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <SummaryDetails cycle={cycle} />
                  <Button mt="md" onClick={() => drawer.openCycle(cycle.id)}>
                    View complete lifecycle
                  </Button>
                </Table.Td>
              </Table.Tr>
            )}
          </Fragment>
        ))}
      </Table.Tbody>
    </DataTable>
  );
  return (
    <main className={classes.page}>
      <Stack gap="lg">
        <Group
          justify="space-between"
          align="flex-end"
          className={classes.header}
        >
          <div>
            <Title order={2}>Trade History</Title>
            <Text c="dimmed" size="sm">
              {accountScope.isAll
                ? "Canonical trade cycles across accessible Trading Accounts."
                : `${accountScope.selectedAccount?.displayName} · ${accountScope.selectedAccount?.environment ?? ""} canonical trade cycles.`}
            </Text>
          </div>
          <Group>
            <TradingAccountScopeSelector mode="ACCOUNT_FILTERABLE" expanded variant="dashboard" />
            <Button
              variant="default"
              leftSection={<IconRefresh size={16} />}
              onClick={() => void cyclesQuery.refetch()}
              loading={cyclesQuery.isFetching}
            >
              Refresh
            </Button>
          </Group>
        </Group>
        <Card withBorder radius="md" p="md">
          <Stack gap="md">
            <ResponsiveFilterToolbar
              primary={
                <TextInput
                  aria-label="Search by symbol"
                  label="Symbol"
                  placeholder="SPY"
                  leftSection={<IconSearch size={16} />}
                  value={symbolDraft}
                  onChange={(event) => setSymbolDraft(event.currentTarget.value)}
                  onKeyDown={(event) => event.key === "Enter" && applyTextFilters()}
                />
              }
              secondary={
                <>
                  <Select
                    label="Status"
                    className={classes.statusFilter}
                    value={status ?? "closed"}
                    onChange={(value) => setStatus(value ?? "closed")}
                    data={[
                      { value: "closed", label: "Closed" },
                      { value: "open", label: "Open" },
                      { value: "closing", label: "Closing" },
                      { value: "all", label: "All" },
                    ]}
                  />
                  <Select
                    label="Mode"
                    className={classes.modeFilter}
                    value={mode}
                    onChange={(value) => setMode(value ?? "all")}
                    data={[
                      { value: "all", label: "All modes" },
                      { value: "paper", label: "Paper" },
                      { value: "live", label: "Live" },
                    ]}
                  />
                  <TextInput
                    type="date"
                    label="Opened from"
                    className={classes.dateFilter}
                    value={dateFrom}
                    onChange={(event) => setDateFrom(event.currentTarget.value)}
                  />
                  <TextInput
                    type="date"
                    label="Opened through"
                    className={classes.dateFilter}
                    value={dateTo}
                    onChange={(event) => setDateTo(event.currentTarget.value)}
                  />
                  <Select
                    label="Per page"
                    className={classes.pageSizeFilter}
                    value={String(pageSize)}
                    data={PAGE_SIZE_OPTIONS.map(String)}
                    onChange={(value) => setPageSize(Number(value ?? 25))}
                  />
                  <Button className={classes.filterButton} onClick={applyTextFilters}>Filter Results</Button>
                </>
              }
              activeFilters={active}
              onClearAll={clear}
            />
            {cyclesQuery.isLoading ? (
              <DataState state="loading" message="Loading trade history…" />
            ) : cyclesQuery.isError ? (
              <DataState
                state="error"
                title="Failed to load trade history"
                message={
                  cyclesQuery.error instanceof Error
                    ? cyclesQuery.error.message
                    : undefined
                }
                onRetry={() => void cyclesQuery.refetch()}
              />
            ) : cycles.length === 0 ? (
              <DataState
                state="empty"
                title="No matching trade cycles"
                message="No canonical trade cycles match the current filters."
                action={{ label: "Clear filters", onClick: clear }}
              />
            ) : (
              <ResponsiveDataView
                records={cycles}
                getRecordId={(cycle) => cycle.id}
                wide={wide}
                compact={(items) => (
                  <CompactRecordList
                    records={items}
                    getRecordId={(cycle) => cycle.id}
                    renderIdentity={identity}
                    renderFields={fields}
                    renderDetails={(cycle) => (
                      <>
                        <SummaryDetails cycle={cycle} />
                        <Button
                          mt="md"
                          onClick={() => drawer.openCycle(cycle.id)}
                        >
                          View complete lifecycle
                        </Button>
                      </>
                    )}
                    expandedId={expanded}
                    onExpandedChange={(id) => setExpanded(id as number | null)}
                  />
                )}
                narrow={(items) => (
                  <MobileRecordCard
                    records={items}
                    getRecordId={(cycle) => cycle.id}
                    renderIdentity={identity}
                    renderStatus={(cycle) => (
                      <StatusBadge
                        status={cycle.status}
                        label={formatStatusLabel(cycle.status)}
                        tone={statusTone(cycle.status)}
                        size="compact"
                      />
                    )}
                    renderFields={fields}
                    onDetails={(cycle) => drawer.openCycle(cycle.id)}
                    detailsLabel="View lifecycle"
                  />
                )}
                aria-label="Trade history"
              />
            )}
            {(pagination?.totalPages ?? 1) > 1 && (
              <Group justify="space-between" className={classes.pagination}>
                <Text size="sm" c="dimmed">
                  Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, pagination?.total ?? 0)} of {pagination?.total ?? 0}
                </Text>
                <Pagination value={page} total={pagination?.totalPages ?? 1} onChange={setPage} disabled={cyclesQuery.isFetching} />
              </Group>
            )}
          </Stack>
        </Card>
      </Stack>
      <TradeCycleDrawer {...drawer.drawerProps} onClose={drawer.closeCycle} />
    </main>
  );
}

import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
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
  const limit = Number(params.get("limit")) || 50;
  const symbol = params.get("symbol") ?? "";
  const status = params.has("status") ? params.get("status") : "closed";
  const mode = params.get("mode") ?? "all";
  const dateFrom = params.get("dateFrom") ?? "";
  const dateTo = params.get("dateTo") ?? "";
  const update = (key: string, value: string, fallback = "") =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === fallback || value === "") next.delete(key);
      else next.set(key, value);
      return next;
    });
  const setLimit = (value: number) => update("limit", String(value), "50");
  const setSymbol = (value: string) => update("symbol", value);
  const setStatus = (value: string | null) =>
    update("status", value ?? "", "closed");
  const setMode = (value: string) => update("mode", value, "all");
  const setDateFrom = (value: string) => update("dateFrom", value);
  const setDateTo = (value: string) => update("dateTo", value);
  const query = useMemo<TradeCyclesQuery>(
    () => ({
      account: accountScope.isAll ? "all" : accountScope.selectedAccount?.id,
      limit,
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
      limit,
      mode,
      status,
      symbol,
    ],
  );
  const cyclesQuery = useTradeCycles(token, query);
  const cycles = cyclesQuery.data?.cycles ?? [];
  const clear = () => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const key of ["symbol", "status", "mode", "dateFrom", "dateTo", "limit"]) next.delete(key);
      return next;
    });
  };
  const active = [
    {
      key: "status",
      active: status !== "closed",
      label: `Status: ${status ? formatStatusLabel(status) : "All"}`,
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
    {
      key: "limit",
      active: limit !== 50,
      label: `Last ${limit}`,
      remove: () => setLimit(50),
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
                  value={symbol}
                  onChange={(event) => setSymbol(event.currentTarget.value)}
                />
              }
              secondary={
                <>
                  <Select
                    label="Status"
                    value={status ?? ""}
                    onChange={(value) => setStatus(value || null)}
                    data={[
                      { value: "closed", label: "Closed" },
                      { value: "open", label: "Open" },
                      { value: "closing", label: "Closing" },
                      { value: "", label: "All" },
                    ]}
                  />
                  <Select
                    label="Mode"
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
                    value={dateFrom}
                    onChange={(event) => setDateFrom(event.currentTarget.value)}
                  />
                  <TextInput
                    type="date"
                    label="Opened through"
                    value={dateTo}
                    onChange={(event) => setDateTo(event.currentTarget.value)}
                  />
                  <NumberInput
                    label="Limit"
                    min={1}
                    max={250}
                    value={limit}
                    onChange={(value) =>
                      typeof value === "number" && setLimit(value)
                    }
                  />
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
          </Stack>
        </Card>
      </Stack>
      <TradeCycleDrawer {...drawer.drawerProps} onClose={drawer.closeCycle} />
    </main>
  );
}

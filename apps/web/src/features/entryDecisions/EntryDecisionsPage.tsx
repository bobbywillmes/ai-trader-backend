import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Accordion,
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
import {
  IconChevronDown,
  IconChevronUp,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import {
  CompactRecordList,
  DataState,
  DataTable,
  MobileRecordCard,
  RecordDetailsGrid,
  ResponsiveDataView,
  ResponsiveFilterToolbar,
  StatusBadge,
  type ActiveFilter,
  type StatusTone,
  type SummaryField,
} from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { EntryDecisionDrawer } from "./EntryDecisionDrawer";
import { useEntryDecisionDrawer, useEntryDecisions } from "./hooks";
import type { EntryDecisionQuery, EntryDecisionSummary } from "./types";
import classes from "./EntryDecisionsPage.module.css";
import { TradingAccountScopeSelector } from "../tradingAccountScope/TradingAccountScopeSelector";
import { useTradingAccountScope } from "../tradingAccountScope/useTradingAccountScope";

const MISSING_VALUE = "Not available";

function normalizeLimit(value: string | number, fallback: number) {
  if (value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function humanize(value: string | null | undefined) {
  if (!value) return MISSING_VALUE;
  const labels: Record<string, string> = {
    below_prev_close_but_dip_threshold_not_met:
      "Below previous close, but dip threshold not met",
    no_dip_yet: "No qualifying dip yet",
    active_position: "Position already open",
    dip_detected: "Dip detected",
    decision_state_changed: "Decision state changed",
    eligible: "Eligible",
    ineligible: "Ineligible",
    waiting: "Waiting",
    idle: "Idle",
  };
  return (
    labels[value.toLowerCase()] ??
    value
      .replaceAll("_", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}
function scope(decision: EntryDecisionSummary) {
  return (
    decision.tradingAccount?.displayName ??
    (decision.tradingAccountId === null
      ? "Legacy / Unattributed"
      : `Account ${decision.tradingAccountId}`)
  );
}
function reason(decision: EntryDecisionSummary) {
  return humanize(
    decision.blockingReason ??
      decision.decisionReason ??
      decision.persistenceReason,
  );
}
function rawReason(decision: EntryDecisionSummary) {
  return decision.blockingReason ?? decision.decisionReason ?? MISSING_VALUE;
}
function signalLabel(decision: EntryDecisionSummary) {
  if (decision.signalCreated) return "Signal emitted";
  if (decision.signalBlocked) return "Blocked";
  if (decision.signalEligible === true) return "Eligible";
  if (decision.signalEligible === false) return "No signal";
  return "Recorded";
}
function signalTone(decision: EntryDecisionSummary): StatusTone {
  if (decision.signalCreated) return "positive";
  if (decision.signalBlocked) return "danger";
  if (decision.signalEligible) return "informational";
  return "neutral";
}
function stateTone(state: string): StatusTone {
  const value = state.toLowerCase();
  if (
    value.includes("allow") ||
    value.includes("eligible") ||
    value.includes("dip")
  )
    return "positive";
  if (
    value.includes("block") ||
    value.includes("deny") ||
    value.includes("ineligible")
  )
    return "danger";
  if (value.includes("wait") || value.includes("cooldown")) return "warning";
  return "informational";
}
function formatDate(value: string | null) {
  if (!value) return MISSING_VALUE;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? MISSING_VALUE
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}
function formatMoney(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? MISSING_VALUE
    : value.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      });
}
function formatPercent(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? MISSING_VALUE
    : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}
function availability(
  value: boolean | null,
  enabled: string,
  disabled: string,
) {
  return value === null ? MISSING_VALUE : value ? enabled : disabled;
}
function lifecycle(value: number | null) {
  return value === null ? "Not created" : `ID ${value}`;
}

export function EntryDecisionsPage() {
  const [token] = useState(() => getAdminToken());
  const accountScope = useTradingAccountScope();
  const [params, setParams] = useSearchParams();
  const limit = Number(params.get("limit")) || 100;
  const symbolFilter = params.get("symbol") ?? "";
  const stateFilter = params.get("decisionState") ?? "";
  const signalFilter = params.get("signal") ?? "all";
  const updateFilter = (key: string, value: string, fallback = "") =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === fallback || value === "") next.delete(key);
      else next.set(key, value);
      return next;
    });
  const setLimit = (value: number) => updateFilter("limit", String(value), "100");
  const setSymbolFilter = (value: string) => updateFilter("symbol", value);
  const setStateFilter = (value: string) => updateFilter("decisionState", value);
  const setSignalFilter = (value: string) => updateFilter("signal", value, "all");
  const [expandedId, setExpandedId] = useState<string | number | null>(null);
  const [detailOpener, setDetailOpener] = useState<HTMLElement | null>(null);
  const drawer = useEntryDecisionDrawer(token);
  const hasActiveFilters =
    symbolFilter.trim() !== "" ||
    stateFilter.trim() !== "" ||
    signalFilter !== "all" ||
    limit !== 100;
  const query = useMemo(() => {
    const next: EntryDecisionQuery = {
      account: accountScope.isAll ? "all" : accountScope.selectedAccount?.id,
      limit,
    };
    const symbol = symbolFilter.trim().toUpperCase();
    const state = stateFilter.trim();
    if (symbol) next.symbol = symbol;
    if (state) next.decisionState = state;
    if (signalFilter === "created") next.signalCreated = true;
    if (signalFilter === "blocked") next.signalBlocked = true;
    return next;
  }, [
    accountScope.isAll,
    accountScope.selectedAccount?.id,
    limit,
    signalFilter,
    stateFilter,
    symbolFilter,
  ]);
  const decisionsQuery = useEntryDecisions(token, query);
  const decisions = decisionsQuery.data?.decisions ?? [];
  function clearFilters() {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const key of ["symbol", "decisionState", "signal", "limit"]) next.delete(key);
      return next;
    });
  }
  function openDetails(decision: EntryDecisionSummary, opener: HTMLElement) {
    setDetailOpener(opener);
    drawer.openDecision(decision.id);
  }
  function closeDetails() {
    const opener = detailOpener;
    drawer.closeDecision();
    window.setTimeout(() => opener?.focus(), 0);
  }

  const activeFilters: ActiveFilter[] = [
    ...(symbolFilter.trim()
      ? [
          {
            key: "symbol",
            label: `Symbol: ${symbolFilter.trim().toUpperCase()}`,
            onRemove: () => setSymbolFilter(""),
          },
        ]
      : []),
    ...(stateFilter.trim()
      ? [
          {
            key: "state",
            label: `State: ${stateFilter.trim()}`,
            onRemove: () => setStateFilter(""),
          },
        ]
      : []),
    ...(signalFilter !== "all"
      ? [
          {
            key: "signal",
            label: `Signal: ${humanize(signalFilter)}`,
            onRemove: () => setSignalFilter("all"),
          },
        ]
      : []),
    ...(limit !== 100
      ? [
          {
            key: "limit",
            label: `Limit: ${limit}`,
            onRemove: () => setLimit(100),
          },
        ]
      : []),
  ];
  const primaryFilter = (
    <TextInput
      label="Symbol"
      placeholder="SPY"
      leftSection={<IconSearch size={16} />}
      value={symbolFilter}
      onChange={(event) => setSymbolFilter(event.currentTarget.value)}
      className={classes.symbolFilter}
    />
  );
  const secondaryFilters = (
    <>
      <TextInput
        label="State"
        placeholder="eligible"
        value={stateFilter}
        onChange={(event) => setStateFilter(event.currentTarget.value)}
        className={classes.stateFilter}
      />
      <Select
        label="Signal"
        value={signalFilter}
        onChange={(value) => setSignalFilter(value ?? "all")}
        data={[
          { value: "all", label: "All" },
          { value: "created", label: "Created" },
          { value: "blocked", label: "Blocked" },
        ]}
        className={classes.signalFilter}
      />
      <NumberInput
        label="Limit"
        min={1}
        max={500}
        value={limit}
        onChange={(value) => setLimit(normalizeLimit(value, limit))}
        className={classes.limitFilter}
      />
      <Button
        variant="default"
        leftSection={<IconX size={16} />}
        onClick={clearFilters}
        disabled={!hasActiveFilters}
      >
        Clear
      </Button>
    </>
  );

  const identity = (decision: EntryDecisionSummary) => (
    <div className={classes.identity}>
      <Text component="h3" fw={800}>
        {decision.symbol}
      </Text>
      <Text size="xs" c="dimmed" className={classes.wrap}>
        {accountScope.isAll
          ? `${scope(decision)}${decision.tradingAccount?.environment ? ` · ${decision.tradingAccount.environment}` : ""} · `
          : ""}
        {formatDate(decision.evaluatedAt)}
      </Text>
    </div>
  );
  const badges = (decision: EntryDecisionSummary) => (
    <Group gap="xs" wrap="wrap">
      <StatusBadge
        status={decision.decisionState}
        label={humanize(decision.decisionState)}
        tone={stateTone(decision.decisionState)}
        size="compact"
      />
      <StatusBadge
        status={signalLabel(decision)}
        label={signalLabel(decision)}
        tone={signalTone(decision)}
        size="compact"
      />
    </Group>
  );
  const fields = (decision: EntryDecisionSummary): SummaryField[] => [
    { label: "Reason", value: reason(decision) },
    {
      label: "Market",
      value: `${formatMoney(decision.currentPrice)} · ${formatPercent(decision.dipPercent)} dip`,
    },
    { label: "Threshold", value: formatPercent(decision.dipThresholdPercent) },
  ];
  const details = (decision: EntryDecisionSummary) => (
    <div className={classes.detailComposition}>
      <div className={classes.detailCards}>
        <section className={classes.detailCard}>
          <Title order={3} size="h5" className={classes.detailHeading}>
            Decision
          </Title>
          <RecordDetailsGrid
            missingValue={MISSING_VALUE}
            sections={[
              {
                items: [
                  { label: "Symbol", value: decision.symbol },
                  {
                    label: "Evaluated",
                    value: formatDate(decision.evaluatedAt),
                  },
                  { label: "Scope", value: scope(decision) },
                  { label: "State", value: humanize(decision.decisionState) },
                  { label: "Signal outcome", value: signalLabel(decision) },
                  { label: "Reason", value: reason(decision) },
                ],
              },
            ]}
          />
        </section>
        <section className={`${classes.detailCard} ${classes.marketCard}`}>
          <Title order={3} size="h5" className={classes.detailHeading}>
            Market evaluation
          </Title>
          <RecordDetailsGrid
            missingValue={MISSING_VALUE}
            sections={[
              {
                items: [
                  { label: "Price", value: formatMoney(decision.currentPrice) },
                  {
                    label: "Dip percentage",
                    value: formatPercent(decision.dipPercent),
                  },
                  {
                    label: "Required threshold",
                    value: formatPercent(decision.dipThresholdPercent),
                  },
                  {
                    label: "Market session",
                    value: humanize(decision.marketSession),
                  },
                ],
              },
            ]}
          />
        </section>
        <section className={classes.detailCard}>
          <Title order={3} size="h5" className={classes.detailHeading}>
            Runtime &amp; routing
          </Title>
          <RecordDetailsGrid
            missingValue={MISSING_VALUE}
            sections={[
              {
                items: [
                  {
                    label: "Evaluation trigger",
                    value: humanize(decision.persistenceReason),
                  },
                  {
                    label: "Orders",
                    value: availability(
                      decision.allowOrderSignals,
                      "Enabled",
                      "Disabled",
                    ),
                  },
                  {
                    label: "Trading",
                    value: availability(
                      decision.tradingEnabled,
                      "Enabled",
                      "Disabled",
                    ),
                  },
                  { label: "Strategy", value: decision.strategyKey },
                  { label: "Subscription", value: decision.subscriptionKey },
                  { label: "Account assignment", value: scope(decision) },
                ],
              },
            ]}
          />
        </section>
        <section className={classes.detailCard}>
          <Title order={3} size="h5" className={classes.detailHeading}>
            Lifecycle links
          </Title>
          <RecordDetailsGrid
            missingValue={MISSING_VALUE}
            sections={[
              {
                items: [
                  {
                    label: "Entry decision",
                    value: `ID ${decision.id}`,
                    technical: true,
                  },
                  {
                    label: "Order intent",
                    value: lifecycle(decision.orderIntentId),
                    technical: true,
                  },
                  {
                    label: "Broker order",
                    value: lifecycle(decision.brokerOrderRecordId),
                    technical: true,
                  },
                  {
                    label: "Position",
                    value: lifecycle(decision.trackedPositionId),
                    technical: true,
                  },
                ],
              },
            ]}
          />
        </section>
      </div>
      <Accordion variant="contained" radius="md">
        <Accordion.Item value="raw">
          <Accordion.Control>
            <div>
              <Text fw={700} size="sm">
                Raw diagnostics
              </Text>
              <Text size="xs" c="dimmed" className={classes.technical}>
                {rawReason(decision)}
              </Text>
            </div>
          </Accordion.Control>
          <Accordion.Panel>
            <RecordDetailsGrid
              missingValue={MISSING_VALUE}
              sections={[
                {
                  items: [
                    {
                      label: "Raw reason",
                      value: rawReason(decision),
                      technical: true,
                    },
                    {
                      label: "Decision state",
                      value: decision.decisionState,
                      technical: true,
                    },
                    {
                      label: "Persistence event",
                      value: decision.persistenceReason,
                      technical: true,
                    },
                    {
                      label: "Source",
                      value: decision.source,
                      technical: true,
                    },
                    {
                      label: "Decision key",
                      value: decision.decisionKey,
                      technical: true,
                    },
                  ],
                },
              ]}
            />
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </div>
  );

  const wide = (items: readonly EntryDecisionSummary[]) => (
    <DataTable caption="Stored entry decisions" captionHidden density="compact">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Decision</Table.Th>
          <Table.Th>State / signal</Table.Th>
          <Table.Th>Reason</Table.Th>
          <Table.Th>Market</Table.Th>
          <Table.Th>Runtime / lifecycle</Table.Th>
          <Table.Th className={classes.actionsHeading}>Actions</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {items.map((decision) => (
          <Fragment key={decision.id}>
            <Table.Tr>
              <Table.Td>{identity(decision)}</Table.Td>
              <Table.Td>{badges(decision)}</Table.Td>
              <Table.Td className={classes.reason}>{reason(decision)}</Table.Td>
              <Table.Td>
                <Text size="sm" fw={600}>
                  {formatMoney(decision.currentPrice)}
                </Text>
                <Text size="xs" c="dimmed">
                  {formatPercent(decision.dipPercent)} dip ·{" "}
                  {formatPercent(decision.dipThresholdPercent)} threshold
                </Text>
              </Table.Td>
              <Table.Td>
                <Text size="sm">
                  {decision.subscriptionKey ?? "No subscription"}
                </Text>
                <Text size="xs" c="dimmed">
                  Intent: {lifecycle(decision.orderIntentId)}
                </Text>
              </Table.Td>
              <Table.Td>
                <Group justify="flex-end" wrap="nowrap">
                  <Button
                    variant="default"
                    size="compact-sm"
                    aria-expanded={expandedId === decision.id}
                    onClick={() =>
                      setExpandedId(
                        expandedId === decision.id ? null : decision.id,
                      )
                    }
                    rightSection={
                      expandedId === decision.id ? (
                        <IconChevronUp size={15} />
                      ) : (
                        <IconChevronDown size={15} />
                      )
                    }
                  >
                    Details
                  </Button>
                </Group>
              </Table.Td>
            </Table.Tr>
            {expandedId === decision.id && (
              <Table.Tr>
                <Table.Td colSpan={6} className={classes.inlineDetails}>
                  {details(decision)}
                </Table.Td>
              </Table.Tr>
            )}
          </Fragment>
        ))}
      </Table.Tbody>
    </DataTable>
  );
  const compact = (items: readonly EntryDecisionSummary[]) => (
    <CompactRecordList
      records={items}
      getRecordId={(decision) => decision.id}
      renderIdentity={(decision) => (
        <Stack gap="xs">
          {identity(decision)}
          {badges(decision)}
        </Stack>
      )}
      renderFields={fields}
      renderDetails={details}
      expandedId={expandedId}
      onExpandedChange={setExpandedId}
    />
  );
  const narrow = (items: readonly EntryDecisionSummary[]) => (
    <MobileRecordCard
      records={items}
      getRecordId={(decision) => decision.id}
      renderIdentity={identity}
      renderStatus={badges}
      renderFields={fields}
      onDetails={openDetails}
    />
  );

  return (
    <main className={classes.page}>
      <Stack gap="lg">
        <Group justify="space-between" align="flex-end">
          <div>
            <Title order={2} size="h3">
              Entry Decisions
            </Title>
            <Text size="sm" c="dimmed">
              {accountScope.isAll
                ? "Stored entry evaluations across accessible Trading Accounts, including owner-visible legacy records."
                : `${accountScope.selectedAccount?.displayName} · ${accountScope.selectedAccount?.environment ?? ""} entry evaluations.`}
            </Text>
          </div>
          <Group>
            <TradingAccountScopeSelector mode="ACCOUNT_FILTERABLE" expanded variant="dashboard" />
            <Button
              leftSection={<IconRefresh size={16} />}
              variant="default"
              onClick={() => void decisionsQuery.refetch()}
              loading={decisionsQuery.isFetching}
            >
              Refresh
            </Button>
          </Group>
        </Group>
        <Card withBorder radius="md" p="md" className={classes.panel}>
          <Stack gap="md">
            <ResponsiveFilterToolbar
              primary={primaryFilter}
              secondary={secondaryFilters}
              activeFilters={activeFilters}
              onClearAll={clearFilters}
              title="Entry decision filters"
            />
            {decisionsQuery.isLoading ? (
              <DataState state="loading" message="Loading entry decisions…" />
            ) : decisionsQuery.isError ? (
              <DataState
                state="error"
                title="Unable to load entry decisions"
                message={
                  decisionsQuery.error instanceof Error
                    ? decisionsQuery.error.message
                    : "Entry decisions could not be loaded."
                }
                onRetry={() => void decisionsQuery.refetch()}
              />
            ) : decisions.length === 0 ? (
              <DataState
                state="empty"
                title={
                  hasActiveFilters
                    ? "No matching entry decisions"
                    : "No entry decisions"
                }
                message={
                  hasActiveFilters
                    ? "No stored decisions match the current filters."
                    : "Stored entry evaluations will appear here."
                }
                action={
                  hasActiveFilters
                    ? { label: "Clear filters", onClick: clearFilters }
                    : undefined
                }
              />
            ) : (
              <ResponsiveDataView
                records={decisions}
                getRecordId={(decision) => decision.id}
                wide={wide}
                compact={compact}
                narrow={narrow}
                aria-label="Entry decisions"
              />
            )}
          </Stack>
        </Card>
      </Stack>
      <EntryDecisionDrawer {...drawer.drawerProps} onClose={closeDetails} />
    </main>
  );
}

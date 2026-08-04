import { Fragment, useState } from "react";
import { Button, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { useNavigate } from "react-router-dom";
import {
  CompactRecordList,
  DataState,
  DataTable,
  MobileRecordCard,
  RecordDetailsGrid,
  ResponsiveDataView,
  StatusBadge,
  type StatusTone,
  type SummaryField,
} from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { useIsSystemOwner } from "../auth/useAuth";
import { CreateTradingAccountModal } from "./CreateTradingAccountModal";
import { useTradingAccountRiskHealthSummaries, useTradingAccounts } from "./hooks";
import type { TradingAccount, TradingAccountRiskHealthStatus } from "./types";
import classes from "./TradingAccountsPage.module.css";

const MISSING_VALUE = "Not available";

function money(value: number | null | undefined, currency: string) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? MISSING_VALUE
    : value.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 2 });
}

function dateTime(value: string | null | undefined) {
  if (!value) return MISSING_VALUE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? MISSING_VALUE : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function statusTone(account: TradingAccount): StatusTone {
  if (account.status === "ACTIVE") return "positive";
  if (account.status === "PAUSED" || account.status === "NEEDS_CREDENTIALS") return "warning";
  if (account.status === "ERROR") return "danger";
  return "neutral";
}

function readinessLabel(status: TradingAccountRiskHealthStatus | null, loading: boolean, error: boolean) {
  if (loading) return "Loading";
  if (error || !status) return "Unknown";
  if (status === "READY_WITH_WARNINGS") return "Ready with warnings";
  return status === "READY" ? "Ready" : "Blocked";
}

function readinessTone(status: TradingAccountRiskHealthStatus | null): StatusTone {
  if (status === "READY") return "positive";
  if (status === "READY_WITH_WARNINGS") return "warning";
  if (status === "BLOCKED") return "danger";
  return "neutral";
}

export function TradingAccountsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [createOpened, setCreateOpened] = useState(false);
  const [expandedId, setExpandedId] = useState<string | number | null>(null);
  const navigate = useNavigate();
  const isSystemOwner = useIsSystemOwner();
  const query = useTradingAccounts(token);
  const accounts = query.data?.accounts ?? [];
  const healthQueries = useTradingAccountRiskHealthSummaries(accounts.map((account) => account.id), token);
  const healthFor = (account: TradingAccount) => healthQueries[accounts.findIndex((item) => item.id === account.id)];
  const openAccount = (account: TradingAccount) => navigate(`/trading-accounts/${account.id}`);

  const identity = (account: TradingAccount) => <div className={classes.identity}><Text component="h3" fw={800}>{account.displayName}</Text><Text size="xs" c="dimmed" className={classes.wrap}>{account.accountHolderName || "No account holder"} · ID {account.id}</Text></div>;
  const environment = (account: TradingAccount) => <Group gap="xs" wrap="wrap"><StatusBadge status={account.environment} tone={account.environment === "LIVE" ? "danger" : "informational"} size="compact" /><Text size="sm">{account.broker}</Text></Group>;
  const operational = (account: TradingAccount) => <StatusBadge status={account.status} tone={statusTone(account)} size="compact" />;
  const safety = (account: TradingAccount) => <Stack gap={4}><StatusBadge status={account.tradingEnabled ? "TRADING_ENABLED" : "TRADING_DISABLED"} tone={account.tradingEnabled ? "positive" : "neutral"} size="compact" /><StatusBadge status={account.killSwitchEnabled ? "KILL_SWITCH_ENABLED" : "KILL_SWITCH_OFF"} tone={account.killSwitchEnabled ? "danger" : "positive"} size="compact" /></Stack>;
  const readiness = (account: TradingAccount) => { const health = healthFor(account); const status = health?.data?.riskHealth.status ?? null; const label = readinessLabel(status, health?.isLoading ?? false, health?.isError ?? false); return <StatusBadge status={label} label={label} tone={readinessTone(status)} size="compact" />; };
  const credentials = (account: TradingAccount) => <StatusBadge status={account.credential.exists ? account.credential.status ?? "UNKNOWN" : "NO_CREDENTIALS"} tone={!account.credential.exists ? "warning" : account.credential.status === "ACTIVE" ? "positive" : account.credential.status === "INVALID" ? "danger" : "warning"} size="compact" />;
  const capital = (account: TradingAccount) => <div><Text size="sm" fw={700}>{money(account.lastEquity, account.baseCurrency)}</Text><Text size="xs" c="dimmed">Cash {money(account.lastCash, account.baseCurrency)}</Text></div>;
  const fields = (account: TradingAccount): SummaryField[] => [
    { label: "Operational state", value: operational(account) },
    { label: "Safety", value: <Text size="sm">{account.tradingEnabled ? "Trading enabled" : "Trading disabled"} · {account.killSwitchEnabled ? "Kill switch enabled" : "Kill switch off"}</Text> },
    { label: "Entry readiness", value: readiness(account) },
    { label: "Credentials", value: credentials(account) },
    { label: "Equity", value: money(account.lastEquity, account.baseCurrency) },
  ];
  const details = (account: TradingAccount) => <RecordDetailsGrid missingValue={MISSING_VALUE} sections={[
    { title: "Account", items: [{ label: "Account holder", value: account.accountHolderName }, { label: "Broker", value: account.broker }, { label: "Environment", value: account.environment }, { label: "Base currency", value: account.baseCurrency }] },
    { title: "Capital & synchronization", items: [{ label: "Estimated capital", value: money(account.estimatedTradingCapital, account.baseCurrency) }, { label: "Cash", value: money(account.lastCash, account.baseCurrency) }, { label: "Equity", value: money(account.lastEquity, account.baseCurrency) }, { label: "Buying power", value: money(account.lastBuyingPower, account.baseCurrency) }, { label: "Last broker sync", value: dateTime(account.lastBrokerSyncAt) }] },
  ]} />;
  const action = (account: TradingAccount) => <Button size="compact-sm" variant="default" onClick={() => openAccount(account)}>View account</Button>;

  const wide = (items: readonly TradingAccount[]) => <DataTable caption="Trading accounts" captionHidden density="compact"><Table.Thead><Table.Tr><Table.Th>Account</Table.Th><Table.Th>Environment / broker</Table.Th><Table.Th>Operational state</Table.Th><Table.Th>Safety</Table.Th><Table.Th>Entry readiness</Table.Th><Table.Th>Credentials</Table.Th><Table.Th>Capital summary</Table.Th><Table.Th className={classes.actionsHeading}>Actions</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{items.map((account) => <Fragment key={account.id}><Table.Tr><Table.Td>{identity(account)}</Table.Td><Table.Td>{environment(account)}</Table.Td><Table.Td>{operational(account)}</Table.Td><Table.Td>{safety(account)}</Table.Td><Table.Td>{readiness(account)}</Table.Td><Table.Td>{credentials(account)}</Table.Td><Table.Td>{capital(account)}</Table.Td><Table.Td><Group justify="flex-end">{action(account)}</Group></Table.Td></Table.Tr></Fragment>)}</Table.Tbody></DataTable>;
  const compact = (items: readonly TradingAccount[]) => <CompactRecordList records={items} getRecordId={(account) => account.id} renderIdentity={(account) => <Stack gap="xs">{identity(account)}{environment(account)}</Stack>} renderFields={fields} renderDetails={details} renderActions={action} expandedId={expandedId} onExpandedChange={setExpandedId} />;
  const narrow = (items: readonly TradingAccount[]) => <MobileRecordCard records={items} getRecordId={(account) => account.id} renderIdentity={identity} renderStatus={(account) => <StatusBadge status={account.environment} tone={account.environment === "LIVE" ? "danger" : "informational"} size="compact" />} renderFields={(account) => [{ label: "Broker", value: account.broker }, ...fields(account)]} onDetails={(account) => openAccount(account)} detailsLabel="View account" detailsIsDialog={false} />;

  return <main className={classes.page}><Stack gap="lg"><Group className={classes.heading} justify="space-between" align="flex-end"><div className={classes.headingCopy}><Title order={2} size="h3">Trading Accounts</Title><Text size="sm" c="dimmed">View broker account scope, safety posture, and credential status.</Text></div>{isSystemOwner && <Button className={classes.createButton} onClick={() => setCreateOpened(true)}>New Trading Account</Button>}</Group><CreateTradingAccountModal opened={createOpened} onClose={() => setCreateOpened(false)} token={token} accounts={accounts} /><Card withBorder radius="md" p="md" className={classes.panel}>{query.isLoading ? <DataState state="loading" message="Loading trading accounts…" /> : query.isError ? <DataState state="error" title="Unable to load trading accounts" message={query.error instanceof Error ? query.error.message : "Trading accounts could not be loaded."} onRetry={() => void query.refetch()} /> : accounts.length === 0 ? <DataState state="empty" title="No trading accounts" message="No trading accounts are available to the current user." /> : <ResponsiveDataView records={accounts} getRecordId={(account) => account.id} wide={wide} compact={compact} narrow={narrow} aria-label="Trading accounts" />}</Card></Stack></main>;
}

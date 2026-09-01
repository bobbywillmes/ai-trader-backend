import { Fragment, useState } from "react";
import {
  Alert, Badge, Button, Card, Group, Modal, Select, SimpleGrid, Stack, Table, Text, Title,
} from "@mantine/core";
import { IconArrowLeft, IconShieldCheck } from "@tabler/icons-react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  CompactRecordList, DataState, DataTable, MobileRecordCard, ResponsiveDataView,
  ResponsiveDetails, StatusBadge, formatStatusLabel, type SummaryField,
} from "../../components/data-display";
import { createScopedNavigationTarget } from "../../app/navigationUtils";
import { ApiError, getAdminToken } from "../../lib/api";
import { useTradingAccount, useTradingAccounts } from "../tradingAccounts/hooks";
import type { TradingAccount } from "../tradingAccounts/types";
import type { ReconciliationFinding, RunReconciliationResult } from "./api";
import { useRunReconciliation } from "./hooks";
import { findingIdentity, reconciliationSeverityTone } from "./reconciliationView";
import classes from "./ReconciliationPage.module.css";

function accountOption(account: TradingAccount) {
  return { value: String(account.id), label: `${account.displayName} — ${account.environment}` };
}

function AccountIdentity({ account }: { account: TradingAccount }) {
  const live = account.environment === "LIVE";
  return <Card withBorder radius="md" className={classes.identityPanel}>
    <Group justify="space-between" align="flex-start" wrap="wrap">
      <Stack gap={4} className={classes.identityCopy}>
        <Title order={2} size="h3">{account.displayName}</Title>
        <Text size="sm" c="dimmed">{account.accountHolderName || "Account holder unavailable"} · {account.broker}</Text>
        <Text size="sm">Compare AI Trader lifecycle state with broker state for this TradingAccount.</Text>
      </Stack>
      <Group gap="xs">
        <StatusBadge status={account.environment} label={account.environment} tone={live ? "danger" : "informational"} />
        <StatusBadge status={account.status} label={formatStatusLabel(account.status)} tone={account.status === "ACTIVE" ? "positive" : "warning"} />
        <Badge color={account.credential.exists && account.credential.status === "ACTIVE" ? "teal" : "orange"} variant="light">
          {account.credential.exists ? `Credentials: ${formatStatusLabel(account.credential.status ?? "UNKNOWN")}` : "Credentials unavailable"}
        </Badge>
      </Group>
    </Group>
  </Card>;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  const truthfulLabel =
    label === "Events created"
      ? "Finding events"
      : label === "Attention updates"
        ? "Persisted attention effects"
        : label === "Duplicates skipped"
          ? "Duplicate finding events skipped"
          : label;
  return <Card withBorder radius="md" className={classes.metric}><Text size="xs" c="dimmed">{truthfulLabel}</Text><Text fw={800} size="xl">{value}</Text></Card>;
}

function Details({ finding, result }: { finding: ReconciliationFinding; result: RunReconciliationResult }) {
  return <div className={classes.details}>
    <div className={classes.detailCard}><Text size="xs" c="dimmed">TradingAccount</Text><Text size="sm">{result.account.displayName} · {result.account.environment}</Text></div>
    <div className={classes.detailCard}><Text size="xs" c="dimmed">Entity</Text><Text size="sm">{finding.entityType} {finding.entityId}</Text></div>
    {finding.details && <div className={classes.detailCard}><Text size="xs" c="dimmed">Diagnostic details</Text><pre>{JSON.stringify(finding.details, null, 2)}</pre>{finding.code === "position_attribution_missing" && <Button component={Link} to={`/system/lifecycle-repairs?account=${result.account.tradingAccountId}&position=${finding.entityId}`} variant="light" size="compact-sm">Diagnose repair</Button>}</div>}
  </div>;
}

export function ReconciliationTargetPage() {
  const [token] = useState(() => getAdminToken());
  const location = useLocation();
  const navigate = useNavigate();
  const accountsQuery = useTradingAccounts(token);
  const accounts = accountsQuery.data?.accounts ?? [];
  const requested = new URLSearchParams(location.search).get("account");
  const requestedId = requested && requested !== "all" ? Number(requested) : null;
  const explicitAccount = requestedId && accounts.some((account) => account.id === requestedId) ? requestedId : null;

  if (explicitAccount) return <Navigate replace to={createScopedNavigationTarget(`/trading-accounts/${explicitAccount}/reconciliation`, location.search)} />;

  return <main className={classes.page}><Stack gap="lg">
    <div><Title order={2}>Choose a Reconciliation target</Title><Text size="sm" c="dimmed">Reconciliation requires one explicit TradingAccount. No default account will be selected.</Text></div>
    <Card withBorder radius="md" className={classes.selectionPanel}>
      {accountsQuery.isLoading ? <DataState state="loading" message="Loading TradingAccounts…" /> : accountsQuery.isError ? <DataState state="error" title="TradingAccounts unavailable" message={accountsQuery.error instanceof Error ? accountsQuery.error.message : "Unable to load TradingAccounts."} /> : accounts.length === 0 ? <DataState state="empty" title="No TradingAccounts available" message="There is no authorized reconciliation target." /> : <Select label="Reconciliation target" description="This selects the route target. It does not change your preserved operational scope." placeholder="Choose a TradingAccount" data={accounts.map(accountOption)} value={null} onChange={(value) => { if (value) navigate(createScopedNavigationTarget(`/trading-accounts/${value}/reconciliation`, location.search)); }} allowDeselect={false} searchable />}
    </Card>
  </Stack></main>;
}

export function ReconciliationPage() {
  const { id } = useParams<{ id: string }>();
  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) return <DataState state="error" title="Invalid TradingAccount" message="A valid route TradingAccount ID is required." />;
  return <AccountReconciliationPage key={accountId} tradingAccountId={accountId} />;
}

function AccountReconciliationPage({ tradingAccountId }: { tradingAccountId: number }) {
  const [token] = useState(() => getAdminToken());
  const location = useLocation();
  const navigate = useNavigate();
  const accountQuery = useTradingAccount(tradingAccountId, token);
  const accountsQuery = useTradingAccounts(token);
  const runMutation = useRunReconciliation(tradingAccountId, token);
  const [confirmOpened, setConfirmOpened] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drawerFinding, setDrawerFinding] = useState<ReconciliationFinding | null>(null);
  const account = accountQuery.data?.account;
  const result = runMutation.data;
  const findings = result?.findings ?? [];
  const unavailable = runMutation.error instanceof ApiError && runMutation.error.status === 503;
  const canRun = Boolean(account?.credential.exists && account.credential.status === "ACTIVE");

  function runDry() { runMutation.mutate({ persistEvents: false, persistAttention: false }); }
  function runPersisted() { setConfirmOpened(false); runMutation.mutate({ persistEvents: true, persistAttention: true }); }
  function switchTarget(value: string | null) {
    if (value) navigate(createScopedNavigationTarget(`/trading-accounts/${value}/reconciliation`, location.search));
  }
  const identity = (finding: ReconciliationFinding, index: number) => <div className={classes.identity}><Text component="h3" fw={800}>{finding.symbol || formatStatusLabel(finding.entityType)}</Text><Text size="xs" c="dimmed">{formatStatusLabel(finding.code)} · {finding.entityType} {finding.entityId}</Text><span className={classes.srOnly}>Finding {index + 1}</span></div>;
  const fields = (finding: ReconciliationFinding): SummaryField[] => [{ label: "Discrepancy", value: finding.message }, { label: "Attention", value: finding.attentionCode ? formatStatusLabel(finding.attentionCode) : "No attention update" }, { label: "Account", value: account ? `${account.displayName} · ${account.environment}` : "Not available" }];
  const wide = (items: readonly ReconciliationFinding[]) => <DataTable caption="Reconciliation findings" captionHidden density="compact"><Table.Thead><Table.Tr><Table.Th>Candidate</Table.Th><Table.Th>Account / symbol</Table.Th><Table.Th>Discrepancy</Table.Th><Table.Th>Severity</Table.Th><Table.Th>Attention</Table.Th><Table.Th>Actions</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{items.map((finding, index) => { const findingId = findingIdentity(finding, index); return <Fragment key={findingId}><Table.Tr><Table.Td>{identity(finding, index)}</Table.Td><Table.Td>{account?.displayName}<Text size="xs" c="dimmed">{finding.symbol} · {account?.environment}</Text></Table.Td><Table.Td className={classes.message}>{finding.message}</Table.Td><Table.Td><StatusBadge status={finding.severity} label={formatStatusLabel(finding.severity)} tone={reconciliationSeverityTone(finding.severity)} size="compact" /></Table.Td><Table.Td>{finding.attentionCode ? formatStatusLabel(finding.attentionCode) : "No action"}</Table.Td><Table.Td><Button variant="default" size="compact-sm" aria-expanded={expandedId === findingId} onClick={() => setExpandedId(expandedId === findingId ? null : findingId)}>Details</Button></Table.Td></Table.Tr>{expandedId === findingId && result && <Table.Tr><Table.Td colSpan={6}><Details finding={finding} result={result} /></Table.Td></Table.Tr>}</Fragment>; })}</Table.Tbody></DataTable>;

  return <main className={classes.page}><Stack gap="lg">
    <Group justify="space-between" align="flex-end" className={classes.header}>
      <Button component={Link} to={createScopedNavigationTarget(`/trading-accounts/${tradingAccountId}`, location.search)} variant="subtle" leftSection={<IconArrowLeft size={16} />}>TradingAccount detail</Button>
      <Select label="Reconciliation target" aria-label="Reconciliation target" value={String(tradingAccountId)} onChange={switchTarget} data={(accountsQuery.data?.accounts ?? []).map(accountOption)} disabled={accountsQuery.isLoading} allowDeselect={false} searchable className={classes.targetSelector} />
    </Group>
    {accountQuery.isLoading ? <DataState state="loading" message="Loading reconciliation target…" /> : accountQuery.isError ? <DataState state="error" title="TradingAccount unavailable" message={accountQuery.error instanceof Error ? accountQuery.error.message : "Unable to load the route TradingAccount."} /> : !account ? <DataState state="empty" title="TradingAccount unavailable" message="The route target does not exist or is not authorized." /> : <>
      <div><Title order={1} size="h2">Reconciliation</Title></div>
      <AccountIdentity account={account} />
      {!canRun && <DataState state="empty" title="Reconciliation unavailable" message={`${account.displayName} does not have active verified broker credentials. Broker state was not observed; this is not a zero-discrepancy result.`} />}
      <Card withBorder radius="md" className={classes.runPanel}><Stack gap="md"><div><Title order={3} size="h4">Run reconciliation for {account.displayName}</Title><Text size="sm" c="dimmed">Dry checks only read broker positions and open orders. Persisted checks may create local System Events and mark qualifying local exit states as requiring attention.</Text></div><Group className={classes.runActions}><Button variant="light" onClick={runDry} loading={runMutation.isPending} disabled={runMutation.isPending || !canRun}>Run dry check — {account.environment}</Button><div className={classes.consequential}><Text size="xs" fw={700} c="red">Consequential · {account.environment}</Text><Button color="red" variant="light" onClick={() => setConfirmOpened(true)} disabled={runMutation.isPending || !canRun}>Persist events + attention</Button></div></Group></Stack></Card>
      {runMutation.isError && (unavailable ? <DataState state="empty" title="Reconciliation unavailable" message={`${runMutation.error.message} Broker state was not successfully observed; no zero-discrepancy result or persisted reconciliation effects were produced.`} onRetry={runDry} /> : <DataState state="error" title="Reconciliation failed" message={runMutation.error instanceof Error ? runMutation.error.message : "Unknown reconciliation error."} onRetry={runDry} />)}
      {runMutation.isPending && !result && <DataState state="loading" message={`Running reconciliation for ${account.displayName}…`} />}
      {result && <><SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="sm"><Metric label="Current run" value={result.dryRun ? "Dry run" : "Persisted"} /><Metric label="Findings" value={findings.length} /><Metric label="Critical" value={findings.filter((finding) => finding.severity === "critical").length} /><Metric label="Events created" value={result.eventCount} /><Metric label="Attention updates" value={result.attentionUpdateCount} /><Metric label="Duplicates skipped" value={result.skippedDuplicateEventCount} /></SimpleGrid><Card withBorder radius="md" className={classes.panel}><Stack gap="md"><Group justify="space-between"><div><Title order={3} size="h4">{result.dryRun ? "Reconciliation findings" : "Persisted reconciliation completed"}</Title><Text size="sm" c="dimmed">{account.displayName} · {account.environment} · {result.dryRun ? "Non-persisting dry run" : "Persisted local effects"}</Text></div><StatusBadge status={result.dryRun ? "DRY_RUN" : "PERSISTED"} label={result.dryRun ? "Dry run" : "Persisted"} tone={result.dryRun ? "informational" : "warning"} /></Group>{findings.length === 0 ? <DataState state="empty" title="No discrepancies found" message={`Broker positions and open orders were successfully observed for ${account.displayName}; no reconciliation findings were returned.`} /> : <ResponsiveDataView records={findings} getRecordId={findingIdentity} wide={wide} compact={(items) => <CompactRecordList records={items} getRecordId={findingIdentity} renderIdentity={(finding) => identity(finding, findings.indexOf(finding))} renderFields={fields} renderDetails={(finding) => <Details finding={finding} result={result} />} expandedId={expandedId} onExpandedChange={(value) => setExpandedId(value as string | null)} />} narrow={(items) => <MobileRecordCard records={items} getRecordId={findingIdentity} renderIdentity={(finding) => identity(finding, findings.indexOf(finding))} renderStatus={(finding) => <StatusBadge status={finding.severity} label={formatStatusLabel(finding.severity)} tone={reconciliationSeverityTone(finding.severity)} size="compact" />} renderFields={fields} onDetails={(_finding, opener) => { setDrawerFinding(_finding); opener.focus(); }} />} aria-label="Reconciliation findings" />}</Stack></Card></>}
    </>}
  </Stack><Modal opened={confirmOpened} onClose={() => setConfirmOpened(false)} title={`Persist reconciliation for ${account?.displayName ?? "TradingAccount"}?`} centered><Stack><Alert color="red" icon={<IconShieldCheck />} title={`${account?.environment ?? "TradingAccount"} · local operational state changes`}>{account?.displayName} · {account?.accountHolderName || "Account holder unavailable"}. This action will persist System Events and may mark qualifying local exit states as requiring attention.</Alert><Text size="sm" fw={700}>It does not place, cancel, or modify broker orders or positions.</Text><Text size="sm">Broker positions and open orders will be read for TradingAccount {tradingAccountId}. No other account will be used as a fallback.</Text><Group justify="flex-end" className={classes.modalActions}><Button variant="default" onClick={() => setConfirmOpened(false)}>Cancel</Button><Button color="red" onClick={runPersisted} loading={runMutation.isPending}>Confirm {account?.environment} persisted check</Button></Group></Stack></Modal><ResponsiveDetails opened={Boolean(drawerFinding)} title={drawerFinding ? `${drawerFinding.symbol} reconciliation finding` : "Reconciliation finding"} onClose={() => setDrawerFinding(null)}>{drawerFinding && result && <Details finding={drawerFinding} result={result} />}</ResponsiveDetails></main>;
}

import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Text, TextInput, Title } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import { useLocation } from "react-router-dom";
import { getAdminToken } from "../../lib/api";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import type { LifecycleRepairCase } from "./api";
import { LifecycleRepairCaseDetail } from "./LifecycleRepairCaseDetail";
import classes from "./LifecycleRepairsPage.module.css";
import { useApplyLifecycleRepair, useDiagnoseLifecycleRepair, useLifecycleRepairs } from "./hooks";
import { lifecycleRepairCaseState } from "./lifecycleRepairView";

function displayDate(value: string) { return new Date(value).toLocaleString(); }

function CaseListItem({ item, selected, onSelect }: { item: LifecycleRepairCase; selected: boolean; onSelect: () => void }) {
  const state = lifecycleRepairCaseState(item);
  const before = item.beforeJson && typeof item.beforeJson === "object" && !Array.isArray(item.beforeJson) ? item.beforeJson as Record<string, unknown> : {};
  const latest = item.executions[0];
  return <Button className={classes.caseButton} variant={selected ? "filled" : "light"} color={selected ? "blue" : "gray"} onClick={onSelect} fullWidth>
    <Group justify="space-between" wrap="nowrap" w="100%"><div className={classes.caseIdentity}><Text fw={700}>Case {item.id} · {String(before.symbol ?? "Position")} #{item.targetId}</Text><Text size="xs" c={selected ? undefined : "dimmed"}>{item.tradingAccount.displayName} · Resolve position attribution</Text><Text size="xs" c={selected ? undefined : "dimmed"}>Created {displayDate(item.createdAt)} · {item.executed ? `Executed ${latest ? displayDate(latest.executedAt) : ""}` : `Expires ${displayDate(item.expiresAt)}`}</Text></div><Group gap={6} wrap="wrap" justify="flex-end"><Badge color={item.confidence === "DETERMINISTIC" ? "teal" : "orange"}>{item.confidence}</Badge><Badge color={state.color}>{state.label}</Badge>{latest && <Badge color={latest.result === "SUCCEEDED" ? "teal" : "red"}>{latest.result}</Badge>}</Group></Group>
  </Button>;
}

export function LifecycleRepairsPage() {
  const [token] = useState(() => getAdminToken());
  const location = useLocation();
  const initialQuery = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const accounts = useTradingAccounts(token);
  const [accountId, setAccountId] = useState<number | undefined>(() => { const value = Number(initialQuery.get("account")); return Number.isInteger(value) && value > 0 ? value : undefined; });
  const [positionId, setPositionId] = useState<number | string>(() => { const value = Number(initialQuery.get("position")); return Number.isInteger(value) && value > 0 ? value : ""; });
  const [selected, setSelected] = useState<LifecycleRepairCase | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const cases = useLifecycleRepairs(token, accountId);
  const diagnose = useDiagnoseLifecycleRepair(token);
  const apply = useApplyLifecycleRepair(token);
  const options = useMemo(() => (accounts.data?.accounts ?? []).map((account) => ({ value: String(account.id), label: `${account.displayName} — ${account.environment}` })), [accounts.data]);
  const current = selected ? cases.data?.cases.find((item) => item.id === selected.id) ?? selected : null;

  function runDiagnosis() {
    if (!accountId || typeof positionId !== "number") return;
    diagnose.mutate({ tradingAccountId: accountId, trackedPositionId: positionId }, { onSuccess: (result) => setSelected(result.case) });
  }
  function runApply() {
    if (!current) return;
    apply.mutate({ caseId: current.id, reason, confirmation, attemptKey: crypto.randomUUID() }, { onSuccess: (result) => { setSelected(result.case); setApplyOpen(false); } });
  }
  function diagnoseAgain() {
    setAccountId(current?.tradingAccount.id ?? accountId);
    setPositionId(current ? Number(current.targetId) : positionId);
    if (current) diagnose.mutate({ tradingAccountId: current.tradingAccount.id, trackedPositionId: Number(current.targetId) }, { onSuccess: (result) => setSelected(result.case) });
  }

  const applyNeedsRediagnosis = apply.isError && /expired|superseded|evidence|configuration|target/i.test(apply.error.message);

  return <main><Stack gap="lg">
    <div><Title order={1}>Lifecycle Repairs</Title><Text c="dimmed">Evidence-driven, typed local lifecycle recovery. Phase 1 supports position attribution only.</Text></div>
    <Card withBorder><Stack><Title order={3}>Diagnose a position</Title>{initialQuery.has("position") && <Alert color="blue">Repair target loaded from reconciliation: TradingAccount {accountId ?? "—"}, TrackedPosition {positionId || "—"}.</Alert>}<SimpleGrid cols={{ base: 1, sm: 2 }}><Select label="TradingAccount" data={options} value={accountId ? String(accountId) : null} onChange={(value) => setAccountId(value ? Number(value) : undefined)} searchable /><NumberInput label="TrackedPosition ID" min={1} allowDecimal={false} value={positionId} onChange={setPositionId} /></SimpleGrid><Button onClick={runDiagnosis} loading={diagnose.isPending} disabled={!accountId || typeof positionId !== "number"}>Diagnose repair</Button>{diagnose.isError && <Alert color="red">{diagnose.error.message}</Alert>}</Stack></Card>
    {(cases.data?.cases ?? []).length > 0 && <Card withBorder><Stack><div><Title order={3}>Repair cases</Title><Text size="sm" c="dimmed">Immutable diagnoses and their execution history, newest first.</Text></div>{cases.data!.cases.map((item) => <CaseListItem key={item.id} item={item} selected={current?.id === item.id} onSelect={() => setSelected(item)} />)}</Stack></Card>}
    {current && <LifecycleRepairCaseDetail item={current} onApply={() => setApplyOpen(true)} onDiagnoseAgain={diagnoseAgain} />}
  </Stack><Modal opened={applyOpen} onClose={() => setApplyOpen(false)} title="Apply local lifecycle repair"><Stack><Alert icon={<IconShieldCheck />} color="red">This changes local lifecycle attribution. It performs no broker write.</Alert><TextInput label="Reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} /><TextInput label="Type APPLY POSITION ATTRIBUTION REPAIR" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} /><Button color="red" onClick={runApply} loading={apply.isPending} disabled={!reason.trim() || confirmation !== "APPLY POSITION ATTRIBUTION REPAIR"}>Apply repair</Button>{apply.isError && <Alert color="red" title="Apply unavailable">{apply.error.message}{applyNeedsRediagnosis && <><br />Diagnose again to create a fresh immutable preview.</>}</Alert>}{applyNeedsRediagnosis && <Button variant="light" color="orange" onClick={() => { setApplyOpen(false); diagnoseAgain(); }}>Diagnose Again</Button>}</Stack></Modal></main>;
}

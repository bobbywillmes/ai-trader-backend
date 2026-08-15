import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Code, Group, Modal, NumberInput, Select, Stack, Text, TextInput, Title } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import { useLocation } from "react-router-dom";
import { getAdminToken } from "../../lib/api";
import { useTradingAccounts } from "../tradingAccounts/hooks";
import type { LifecycleRepairCase } from "./api";
import { useApplyLifecycleRepair, useDiagnoseLifecycleRepair, useLifecycleRepairs } from "./hooks";
import { lifecycleRepairApplyState } from "./lifecycleRepairView";

function JsonBlock({ value }: { value: unknown }) { return <Code block>{JSON.stringify(value, null, 2)}</Code>; }

function CaseDetail({ item, onApply }: { item: LifecycleRepairCase; onApply: () => void }) {
  const evidence = item.evidenceJson as Record<string, unknown>;
  const manual = item.confidence !== "DETERMINISTIC";
  const applyState = lifecycleRepairApplyState(item);
  return <Card withBorder><Stack>
    <Group justify="space-between"><Title order={3}>Case {item.id} · Position {item.targetId}</Title><Group><Badge>{item.tradingAccount.environment}</Badge><Badge color={item.confidence === "DETERMINISTIC" ? "teal" : "orange"}>{item.confidence}</Badge></Group></Group>
    <Text>{item.tradingAccount.displayName} · {item.repairType} · {item.impact}</Text>
    {item.tradingAccount.environment === "LIVE" && <Alert color="orange" title="LIVE read-only">Diagnosis is visible, but Apply is prohibited for LIVE TradingAccounts.</Alert>}
    {manual && <Alert color="orange" title="Automatic repair unavailable — manual review required.">{item.nonExecutableReasonsJson.map((reason) => reason.message).join(" ")}</Alert>}
    {item.expired && <Alert color="orange" title="Preview expired">Diagnose again to create a fresh immutable case.</Alert>}
    {item.superseded && <Alert color="orange" title="Preview superseded">A newer immutable diagnosis exists for this target.</Alert>}
    <Title order={4}>Evidence chronology</Title><Text size="sm">Broker order: {String(evidence.brokerOrderId ?? "Unavailable")} · client_order_id: {String(evidence.clientOrderId ?? "Unavailable")}</Text><JsonBlock value={item.evidenceJson} />
    <Title order={4}>Candidate assignments</Title><JsonBlock value={item.candidateResolutionsJson} />
    <Title order={4}>Rejected alternatives</Title><JsonBlock value={item.rejectedAlternativesJson} />
    <Title order={4}>Exact proposed mutations</Title><JsonBlock value={item.proposedMutationsJson} />
    <Title order={4}>Preconditions and expiry</Title><Text size="sm">Expires {new Date(item.expiresAt).toLocaleString()}</Text><JsonBlock value={item.preconditionsJson} />
    <Alert color="blue" title="Repair broker impact"><b>Broker writes during repair: NONE</b><br />Orders submitted during repair: NONE<br />Orders cancelled during repair: NONE<br />Positions closed during repair: NONE</Alert>
    <Alert color="yellow" title="Normal workers resume after repair">{item.brokerImpactJson.laterWorkerWarning}</Alert>
    <Button onClick={onApply} disabled={!applyState.allowed}>{applyState.label}</Button>
    <Title order={4}>Execution and validation history</Title>{item.executions.length ? item.executions.map((execution) => <Card withBorder key={execution.id}><Text fw={700}>{execution.result} · {new Date(execution.executedAt).toLocaleString()}</Text><Text size="sm">Reason: {execution.reason}</Text><JsonBlock value={execution.validationJson ?? execution.failureJson} /></Card>) : <Text c="dimmed">No executions.</Text>}
  </Stack></Card>;
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
  function runDiagnosis() { if (accountId && typeof positionId === "number") diagnose.mutate({ tradingAccountId: accountId, trackedPositionId: positionId }, { onSuccess: (result) => setSelected(result.case) }); }
  function runApply() { if (!current) return; apply.mutate({ caseId: current.id, reason, confirmation, attemptKey: crypto.randomUUID() }, { onSuccess: (result) => { setSelected(result.case); setApplyOpen(false); } }); }
  return <main><Stack gap="lg"><div><Title order={1}>Lifecycle Repairs</Title><Text c="dimmed">Evidence-driven, typed local lifecycle recovery. Phase 1 supports position attribution only.</Text></div>
    <Card withBorder><Stack><Title order={3}>Diagnose a position</Title><Select label="TradingAccount" data={options} value={accountId ? String(accountId) : null} onChange={(value) => setAccountId(value ? Number(value) : undefined)} searchable /><NumberInput label="TrackedPosition ID" min={1} allowDecimal={false} value={positionId} onChange={setPositionId} /><Button onClick={runDiagnosis} loading={diagnose.isPending} disabled={!accountId || typeof positionId !== "number"}>Diagnose repair</Button>{diagnose.isError && <Alert color="red">{diagnose.error.message}</Alert>}</Stack></Card>
    {(cases.data?.cases ?? []).length > 0 && <Card withBorder><Stack><Title order={3}>Repair cases</Title>{cases.data!.cases.map((item) => <Button key={item.id} variant={current?.id === item.id ? "filled" : "light"} onClick={() => setSelected(item)}>Case {item.id} · Position {item.targetId} · {item.confidence}</Button>)}</Stack></Card>}
    {current && <CaseDetail item={current} onApply={() => setApplyOpen(true)} />}
  </Stack><Modal opened={applyOpen} onClose={() => setApplyOpen(false)} title="Apply local lifecycle repair"><Stack><Alert icon={<IconShieldCheck />} color="red">This changes local lifecycle attribution. It performs no broker write.</Alert><TextInput label="Reason" value={reason} onChange={(event) => setReason(event.currentTarget.value)} /><TextInput label="Type APPLY POSITION ATTRIBUTION REPAIR" value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} /><Button color="red" onClick={runApply} loading={apply.isPending} disabled={!reason.trim() || confirmation !== "APPLY POSITION ATTRIBUTION REPAIR"}>Apply repair</Button>{apply.isError && <Alert color="red">{apply.error.message}</Alert>}</Stack></Modal></main>;
}

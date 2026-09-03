import { Accordion, Alert, Badge, Button, Card, Code, Group, SimpleGrid, Stack, Table, Text, TextInput, Title } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import type { LifecycleRepairCase, LifecycleRepairExecution } from "./api";
import { lifecycleRepairApplyState, lifecycleRepairCaseState } from "./lifecycleRepairView";
import classes from "./LifecycleRepairsPage.module.css";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown, fallback = "—"): string { return typeof value === "string" && value.length ? value : typeof value === "number" ? String(value) : fallback; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function date(value: string | unknown): string { return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toLocaleString() : "—"; }
function money(value: unknown): string { const parsed = number(value); return parsed === null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(parsed); }
function titleCase(value: unknown): string { return text(value).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()).replace(/\bAapl\b/g, "AAPL").replace(/\bId\b/g, "ID"); }
function compactClientOrderId(value: unknown): string { const full = text(value); return full.length > 44 ? `${full.slice(0, 20)}…${full.slice(-12)}` : full; }

function RawDisclosure({ label, value }: { label: string; value: unknown }) {
  return <Accordion variant="contained" radius="md"><Accordion.Item value="raw"><Accordion.Control>{label}</Accordion.Control><Accordion.Panel><pre className={classes.raw}>{JSON.stringify(value, null, 2)}</pre></Accordion.Panel></Accordion.Item></Accordion>;
}

function SummaryItem({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text><div>{children}</div></div>;
}

function Status({ pass, children }: { pass: boolean; children: React.ReactNode }) {
  return <Group gap="xs" wrap="nowrap">{pass ? <IconCheck size={17} color="var(--mantine-color-teal-6)" /> : <IconX size={17} color="var(--mantine-color-red-6)" />}<Text size="sm"><b>{pass ? "PASS" : "FAIL"}</b> &nbsp;{children}</Text></Group>;
}

function BrokerEvidence({ item }: { item: LifecycleRepairCase }) {
  const evidence = object(item.evidenceJson);
  const assignment = object(evidence.assignment);
  const activities = array(evidence.activities).map(object);
  const before = object(item.beforeJson);
  return <Card withBorder className={classes.section}><Stack gap="md">
    <div><Title order={3} size="h4">Broker Evidence</Title><Text size="sm" c="dimmed">Exact order ownership and fill corroboration used by this diagnosis.</Text></div>
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
      <SummaryItem label="Broker order"><Text className={classes.identifier}>{text(evidence.brokerOrderId, "Unavailable")}</Text></SummaryItem>
      <SummaryItem label="Client order ID"><Text title={text(evidence.clientOrderId)} className={classes.identifier}>{compactClientOrderId(evidence.clientOrderId)}</Text></SummaryItem>
      <SummaryItem label="Parsed account assignment"><Text fw={700}>TAS {text(assignment.id, "Unavailable")}</Text></SummaryItem>
      <SummaryItem label="Combined quantity"><Text fw={700}>{text(evidence.fillQty)}</Text><Text size="xs" c="teal">Matches tracked position</Text></SummaryItem>
      <SummaryItem label="Weighted average"><Text fw={700}>{money(evidence.weightedAveragePrice)}</Text><Text size="xs" c="teal">Matches tracked position</Text></SummaryItem>
      <SummaryItem label="Tracked position"><Text fw={700}>{text(before.qty)} @ {money(before.avgEntryPrice)}</Text></SummaryItem>
    </SimpleGrid>
    <div><Text fw={700} mb="xs">Fill activities</Text>{activities.length ? <div className={classes.tableWrap}><Table striped withTableBorder>
      <Table.Thead><Table.Tr><Table.Th>Activity</Table.Th><Table.Th>Fill</Table.Th><Table.Th>Side</Table.Th><Table.Th>Quantity</Table.Th><Table.Th>Price</Table.Th><Table.Th>Evidence</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{activities.map((activity, index) => <Table.Tr key={text(activity.id, String(index))}><Table.Td>{text(activity.id)}</Table.Td><Table.Td>{index === activities.length - 1 ? "Final fill" : "Partial fill"}</Table.Td><Table.Td>{text(before.side).toUpperCase() === "SHORT" ? "SELL" : "BUY"}</Table.Td><Table.Td>{text(activity.qty)}</Table.Td><Table.Td>{money(activity.price)}</Table.Td><Table.Td><Badge color="teal" variant="light">Corroborated</Badge></Table.Td></Table.Tr>)}</Table.Tbody>
    </Table></div> : <Text c="dimmed">No fill activities were available.</Text>}</div>
    <RawDisclosure label="Raw evidence" value={item.evidenceJson} />
  </Stack></Card>;
}

function RecommendedAttribution({ item }: { item: LifecycleRepairCase }) {
  const evidence = object(item.evidenceJson); const assignment = object(evidence.assignment);
  const tracked = object(object(item.proposedMutationsJson).trackedPosition);
  const snapshot = object(object(object(tracked.configSnapshotJson).after));
  const subscription = object(snapshot.subscription); const strategy = object(snapshot.strategy); const exitProfile = object(snapshot.exitProfile);
  return <Card withBorder className={classes.section}><Stack gap="md"><div><Title order={3} size="h4">Recommended Attribution</Title><Text size="sm" c="dimmed">The deterministic lifecycle ownership recovered from broker evidence.</Text></div>
    {assignment.id ? <SimpleGrid cols={{ base: 1, sm: 2 }}>
      <SummaryItem label="TradingAccountSubscription"><Text fw={700}>TAS {text(assignment.id)}</Text><Text size="xs" c="dimmed">Assignment ID {text(assignment.id)}</Text></SummaryItem>
      <SummaryItem label="Subscription"><Text fw={700}>{text(subscription.name, titleCase(assignment.subscriptionKey))}</Text><Text size="xs" c="dimmed">{text(subscription.key, text(assignment.subscriptionKey))} · ID {text(subscription.id, text(assignment.subscriptionId))}</Text></SummaryItem>
      <SummaryItem label="Strategy"><Text fw={700}>{text(strategy.name, titleCase(strategy.key))}</Text><Text size="xs" c="dimmed">{text(strategy.key)} · ID {text(strategy.id)}</Text></SummaryItem>
      <SummaryItem label="Exit profile"><Text fw={700}>{text(exitProfile.name, titleCase(assignment.exitProfileKey))}</Text><Text size="xs" c="dimmed">{text(exitProfile.key, text(assignment.exitProfileKey))} · ID {text(exitProfile.id, text(assignment.exitProfileId))}</Text></SummaryItem>
    </SimpleGrid> : <Alert color="orange">No deterministic attribution is available for this case.</Alert>}
    <RawDisclosure label="Raw candidates" value={item.candidateResolutionsJson} />
  </Stack></Card>;
}

function RejectedCandidates({ item }: { item: LifecycleRepairCase }) {
  const rejected = item.rejectedAlternativesJson.map(object); const candidates = item.candidateResolutionsJson.map(object);
  return <Card withBorder className={classes.section}><Stack gap="md"><Title order={3} size="h4">Rejected Candidates</Title>
    {item.confidence !== "DETERMINISTIC" && <Alert color="orange" title="No deterministic repair available">{item.nonExecutableReasonsJson.map((reason) => reason.message).join(" ") || "The evidence does not uniquely identify an assignment."}</Alert>}
    {rejected.length ? rejected.map((candidate, index) => { const id = number(candidate.assignmentId); const details = candidates.find((value) => number(value.assignmentId) === id) ?? {}; return <Card withBorder key={`${id}-${index}`} padding="sm"><Group justify="space-between" align="flex-start"><div><Text fw={700}>{titleCase(details.subscriptionKey)}</Text><Text size="xs" c="dimmed">TAS {text(candidate.assignmentId)} · {text(details.subscriptionKey)}</Text></div><Badge color="red" variant="light">Rejected</Badge></Group><Text size="sm" mt="sm"><b>Rejected because:</b> {text(candidate.reason, "The candidate lacks authoritative ownership evidence.")}</Text></Card>; }) : <Text c="dimmed">No alternative candidate assignments were rejected.</Text>}
    <RawDisclosure label="Raw rejected candidates" value={item.rejectedAlternativesJson} />
  </Stack></Card>;
}

function ProposedChanges({ item }: { item: LifecycleRepairCase }) {
  const proposal = object(item.proposedMutationsJson); const tracked = object(proposal.trackedPosition); const exit = object(proposal.positionExitState);
  const snapshotMutation = object(tracked.configSnapshotJson); const snapshot = object(snapshotMutation.after); const subscription = object(snapshot.subscription);
  const rows = [
    ["Subscription", "TrackedPosition.subscriptionId", text(object(tracked.subscriptionId).before), text(subscription.name, titleCase(subscription.key))],
    ["TradingAccountSubscription", "TrackedPosition.tradingAccountSubscriptionId", text(object(tracked.tradingAccountSubscriptionId).before), `TAS ${text(object(tracked.tradingAccountSubscriptionId).after)}`],
    ["Configuration snapshot", "TrackedPosition.configSnapshotJson", snapshotMutation.before ? "Present" : "Missing", snapshotMutation.after ? "Captured" : "Missing"],
    ["Snapshot captured at", "TrackedPosition.configSnapshotCapturedAt", date(object(tracked.configSnapshotCapturedAt).before), date(object(tracked.configSnapshotCapturedAt).after)],
    ["Exit-state configuration", "PositionExitState", "Missing / pristine", text(exit.action) === "CREATE" ? "Created and hydrated" : "Hydrated"],
  ];
  return <Card withBorder className={classes.section}><Stack gap="md"><div><Title order={3} size="h4">Proposed Changes</Title><Text size="sm" c="dimmed">Every local field group declared by this repair.</Text></div><div className={classes.tableWrap}><Table withTableBorder striped><Table.Thead><Table.Tr><Table.Th>Field</Table.Th><Table.Th>Before</Table.Th><Table.Th>After</Table.Th></Table.Tr></Table.Thead><Table.Tbody>{rows.map(([label, raw, before, after]) => <Table.Tr key={raw}><Table.Td><Text fw={600}>{label}</Text><Text size="xs" c="dimmed">{raw}</Text></Table.Td><Table.Td>{before}</Table.Td><Table.Td fw={600}>{after}</Table.Td></Table.Tr>)}</Table.Tbody></Table></div><RawDisclosure label="Raw mutation plan" value={item.proposedMutationsJson} /></Stack></Card>;
}

function ConfigurationSnapshot({ item }: { item: LifecycleRepairCase }) {
  const tracked = object(object(item.proposedMutationsJson).trackedPosition); const snapshot = object(object(tracked.configSnapshotJson).after);
  const subscription = object(snapshot.subscription); const strategy = object(snapshot.strategy); const exitProfile = object(snapshot.exitProfile);
  return <Card withBorder className={classes.section}><Stack gap="md"><Title order={3} size="h4">Configuration Snapshot</Title><SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
    <SummaryItem label="Subscription"><Text fw={600}>{text(subscription.name, titleCase(subscription.key))}</Text></SummaryItem><SummaryItem label="Strategy"><Text fw={600}>{text(strategy.name, titleCase(strategy.key))}</Text></SummaryItem><SummaryItem label="Exit profile"><Text fw={600}>{text(exitProfile.name, titleCase(exitProfile.key))}</Text></SummaryItem>
    <SummaryItem label="Target / stop"><Text>{text(exitProfile.targetPct)}% / {text(exitProfile.stopLossPct)}%</Text></SummaryItem><SummaryItem label="Trailing / max hold"><Text>{text(exitProfile.trailingStopPct)}% / {text(exitProfile.maxHoldDays)} days</Text></SummaryItem><SummaryItem label="Exit behavior"><Text>{titleCase(exitProfile.exitMode)} · {titleCase(exitProfile.takeProfitBehavior)}</Text></SummaryItem>
    <SummaryItem label="Captured"><Text>{date(snapshot.capturedAt)}</Text></SummaryItem><SummaryItem label="Configuration fingerprint"><Text className={classes.identifier}>{item.configurationFingerprint ?? "Unavailable"}</Text></SummaryItem>
  </SimpleGrid><RawDisclosure label="Raw configuration snapshot" value={snapshot} /></Stack></Card>;
}

function Preconditions({ item, onDiagnoseAgain }: { item: LifecycleRepairCase; onDiagnoseAgain: () => void }) {
  const checks = object(item.preconditionsJson); const deterministic = item.confidence === "DETERMINISTIC";
  return <Card withBorder className={classes.section}><Stack gap="sm"><Group justify="space-between"><Title order={3} size="h4">Preconditions &amp; Validity</Title><Badge color={item.executable ? "teal" : "orange"}>{item.executable ? "Executable" : "Not executable"}</Badge></Group>
    <Status pass={checks.positionAttributionMustRemainNull === true}>Position attribution is still missing</Status><Status pass={checks.exitStateMustRemainPristine === true}>Exit state is safe to hydrate</Status><Status pass={typeof checks.configurationFingerprint === "string"}>Configuration fingerprint matches the frozen preview</Status><Status pass={deterministic}>Broker evidence is deterministic</Status>
    <Text size="sm">Expires: <b>{date(item.expiresAt)}</b></Text>{item.superseded && <Text size="sm" c="orange">Superseded by a newer diagnosis for this target.</Text>}{item.expired && <Text size="sm" c="orange">This immutable preview has expired.</Text>}
    {(item.expired || item.superseded) && <Button variant="light" color="orange" onClick={onDiagnoseAgain}>Diagnose Again</Button>}<RawDisclosure label="Raw preconditions" value={item.preconditionsJson} />
  </Stack></Card>;
}

function ExecutionResult({ execution }: { execution: LifecycleRepairExecution }) {
  const validation = object(execution.validationJson); const checks = object(validation.checks); const after = object(execution.afterJson); const position = object(after.trackedPosition); const exit = object(after.positionExitState);
  const succeeded = execution.result === "SUCCEEDED";
  const brokerMutation = checks.brokerMutationPerformed === true;
  return <Card withBorder className={classes.execution} data-result={execution.result}><Stack gap="sm"><Group justify="space-between"><Title order={4}>Execution {execution.id}</Title><Badge size="lg" color={succeeded ? "teal" : "red"}>{execution.result}</Badge></Group>
    {succeeded ? <SimpleGrid cols={{ base: 1, sm: 2 }}><Status pass={position.subscriptionId !== null && position.subscriptionId !== undefined}>Attribution</Status><Status pass={position.configSnapshotJson !== null && position.configSnapshotJson !== undefined}>Frozen snapshot</Status><Status pass={Boolean(exit.id ?? exit.exitProfileKey)}>Exit state hydrated</Status><Status pass={!brokerMutation}>Broker mutation performed: {brokerMutation ? "YES" : "NO"}</Status></SimpleGrid> : <Alert color="red" title="Execution failed">{text(object(execution.failureJson).message, "The repair was rolled back without a successful mutation.")}</Alert>}
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}><SummaryItem label="Actor"><Text>{execution.executedByUser?.name ?? execution.executedByUser?.email ?? "System Owner"}</Text></SummaryItem><SummaryItem label="Executed"><Text>{date(execution.executedAt)}</Text></SummaryItem><SummaryItem label="Reason"><Text>{execution.reason}</Text></SummaryItem><SummaryItem label="Validation status"><Badge color={validation.valid === true ? "teal" : succeeded ? "orange" : "red"}>{validation.valid === true ? "PASS" : succeeded ? "Unavailable" : "FAIL"}</Badge></SummaryItem></SimpleGrid>
    <RawDisclosure label="Raw execution details" value={{ beforeJson: execution.beforeJson, afterJson: execution.afterJson, validationJson: execution.validationJson, failureJson: execution.failureJson }} />
  </Stack></Card>;
}

export function LifecycleRepairCaseDetail({ item, onApply, onDiagnoseAgain, onDecision, onApplyAction, onReconsider }: { item: LifecycleRepairCase; onApply: () => void; onDiagnoseAgain: () => void; onDecision?: (actionId: number, revision: number, decision: "APPROVE" | "REFUSE", reason: string) => void; onApplyAction?: (actionId: number, revision: number, reason: string, confirmation: string) => void; onReconsider?: (actionId: number, revision: number, reason: string) => void }) {
  const [actionReasons, setActionReasons] = useState<Record<number, string>>({});
  const [actionConfirmations, setActionConfirmations] = useState<Record<number, string>>({});
  const evidence = object(item.evidenceJson); const before = object(item.beforeJson); const applyState = lifecycleRepairApplyState(item); const state = lifecycleRepairCaseState(item); const latest = item.executions[0];
  if (item.repairType === "REPAIR_HISTORICAL_ENTRY_LIFECYCLE") {
    const components = array(evidence.unresolvedComponents);
    const lifecycle = object(evidence.lifecycle); const order = object(lifecycle.brokerOrder); const intent = object(lifecycle.orderIntent);
    const fillAssessment = object(evidence.fillAssessment); const fillSummary = object(fillAssessment.summary);
    const candidates = array(evidence.positionCandidates).map(object);
    return <Stack gap="lg" data-testid="historical-entry-repair-case-detail">
      <Card withBorder><Stack><Group justify="space-between"><div><Text size="xs" c="dimmed">HISTORICAL ENTRY LIFECYCLE CASE {item.id}</Text><Title order={2}>{text(order.symbol)} historical BUY lifecycle</Title></div><Group><Badge>{item.tradingAccount.environment}</Badge><Badge color="orange">{item.confidence}</Badge></Group></Group><Text>Stored full-fill evidence exists, while these local components remain incomplete: {components.join(", ")}.</Text><Alert color="blue" title="No broker or exposure impact">Repair performs no broker calls or writes and changes no position quantity, status, price, P&amp;L, timestamps, or current exposure.</Alert></Stack></Card>
      <Card withBorder><Stack><Title order={3}>Order and fill evidence</Title><SimpleGrid cols={{ base: 1, sm: 2 }}><SummaryItem label="OrderIntent"><Text>ID {text(intent.id)} · {text(intent.status)} · qty {text(intent.qty)}</Text></SummaryItem><SummaryItem label="BrokerOrder"><Text>ID {text(order.id)} · {text(order.status)}</Text><Text size="xs">{text(order.brokerOrderId)}</Text></SummaryItem><SummaryItem label="Fill completion"><Text>{text(fillSummary.cumulativeQty)} filled · {text(fillSummary.leavesQty)} leaves</Text></SummaryItem><SummaryItem label="Fill price"><Text>{money(fillSummary.weightedAveragePrice)}</Text></SummaryItem></SimpleGrid><RawDisclosure label="Complete stored evidence" value={evidence} /></Stack></Card>
      <Card withBorder><Stack><Title order={3}>Candidate positions and predicates</Title>{candidates.length ? candidates.map((candidate) => <Card withBorder key={text(candidate.trackedPositionId)}><Text fw={700}>TrackedPosition {text(candidate.trackedPositionId)}</Text><Text size="sm">Rejected predicates: {array(candidate.rejectionReasons).join(", ") || "none"}</Text><RawDisclosure label="Candidate details" value={candidate} /></Card>) : <Text>No candidate position satisfied the discovery window.</Text>}</Stack></Card>
      {(item.actions ?? []).map((action) => { const reason = actionReasons[action.id] ?? ""; const enteredConfirmation = actionConfirmations[action.id] ?? ""; const confirmation = action.actionType === "TERMINALIZE_ORDER_LIFECYCLE" ? "TERMINALIZE HISTORICAL ORDER LIFECYCLE" : "LINK HISTORICAL ENTRY LIFECYCLE"; const disabled = item.expired || action.status === "SUPERSEDED"; return <Card withBorder key={action.id}><Stack><Group justify="space-between"><Title order={3}>{titleCase(action.actionType)} · generation {action.generation}</Title><Group><Badge>{action.classification}</Badge><Badge>{action.status}</Badge></Group></Group><TextInput label="Required action reason" value={reason} onChange={(event) => setActionReasons((values) => ({ ...values, [action.id]: event.currentTarget.value }))} /><Text size="sm">Action fingerprint: <Code>{action.actionFingerprint}</Code></Text><RawDisclosure label="Backend-proposed field mutations" value={action.proposedMutationsJson} /><Text size="xs">Preview expires {date(item.expiresAt)} · revision {action.revision}</Text>{action.decisionReason && <Text>Decision: {action.decisionReason}</Text>}{action.reconsiderationReason && <Text>Reconsideration: {action.reconsiderationReason}</Text>}{action.status === "PROPOSED" && <Group><Button disabled={disabled || !reason.trim()} onClick={() => onDecision?.(action.id, action.revision, "APPROVE", reason)}>Approve</Button><Button color="red" variant="light" disabled={disabled || !reason.trim()} onClick={() => onDecision?.(action.id, action.revision, "REFUSE", reason)}>Refuse</Button></Group>}{action.status === "REFUSED" && <Button variant="light" disabled={!reason.trim()} onClick={() => onReconsider?.(action.id, action.revision, reason)}>Reconsider with fresh evidence</Button>}{action.status === "APPROVED" && <><TextInput label={`Type ${confirmation}`} value={enteredConfirmation} onChange={(event) => setActionConfirmations((values) => ({ ...values, [action.id]: event.currentTarget.value }))} /><Button color="red" disabled={disabled || !reason.trim() || enteredConfirmation !== confirmation || item.tradingAccount.environment !== "PAPER"} onClick={() => onApplyAction?.(action.id, action.revision, reason, enteredConfirmation)}>Apply approved action</Button></>}{action.status === "APPLIED" && <Alert color="blue">Structurally applied. Authoritative reconciliation verification is pending.</Alert>}{action.executions.map((execution) => <ExecutionResult execution={execution} key={execution.id} />)}</Stack></Card>; })}
      <Button variant="light" onClick={onDiagnoseAgain}>Refresh authoritative preview</Button>
    </Stack>;
  }
  return <Stack gap="lg" data-testid="repair-case-detail">
    <Card withBorder className={classes.summary}><Stack gap="md"><Group justify="space-between" align="flex-start"><div><Text size="xs" c="dimmed">LIFECYCLE REPAIR CASE {item.id}</Text><Title order={2}>Position {item.targetId} · {text(before.symbol, text(evidence.assignment && object(evidence.assignment).symbol))}</Title></div><Group gap="xs"><Badge color={item.tradingAccount.environment === "LIVE" ? "red" : "blue"}>{item.tradingAccount.environment}</Badge><Badge color={item.confidence === "DETERMINISTIC" ? "teal" : "orange"}>{item.confidence}</Badge><Badge color={state.color}>{state.label}</Badge>{latest && <Badge size="lg" color={latest.result === "SUCCEEDED" ? "teal" : "red"}>{latest.result}</Badge>}</Group></Group>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }}><SummaryItem label="Repair type"><Text>{titleCase(item.repairType)}</Text></SummaryItem><SummaryItem label="Trading Account"><Text fw={600}>{item.tradingAccount.displayName}</Text></SummaryItem><SummaryItem label="Resolution source"><Text>{titleCase(item.resolutionSource)}</Text></SummaryItem><SummaryItem label="Impact"><Text fw={700}>LOCAL ONLY</Text></SummaryItem><SummaryItem label="Created / expires"><Text size="sm">{date(item.createdAt)}<br />{date(item.expiresAt)}</Text></SummaryItem></SimpleGrid>
      {item.tradingAccount.environment === "LIVE" && <Alert color="orange" title="LIVE read-only">Diagnosis is visible, but Apply is prohibited for LIVE TradingAccounts.</Alert>}{item.confidence !== "DETERMINISTIC" && <Alert color="orange" title="Automatic repair unavailable — manual review required.">{item.nonExecutableReasonsJson.map((reason) => reason.message).join(" ")}</Alert>}
    </Stack></Card>
    <BrokerEvidence item={item} /><RecommendedAttribution item={item} /><RejectedCandidates item={item} /><ProposedChanges item={item} /><ConfigurationSnapshot item={item} /><Preconditions item={item} onDiagnoseAgain={onDiagnoseAgain} />
    <Card withBorder className={classes.safety}><Stack gap="sm"><Title order={3} size="h4">Broker Impact</Title><Alert color="blue" title="Repair broker impact"><b>Broker writes during repair: NONE</b><br />Orders submitted during repair: NONE<br />Orders cancelled during repair: NONE<br />Positions closed during repair: NONE</Alert><Alert color="yellow" title="Normal workers may resume after repair">{item.brokerImpactJson.laterWorkerWarning}</Alert></Stack></Card>
    <Group justify="flex-end"><Button onClick={onApply} disabled={!applyState.allowed}>{applyState.label}</Button>{(item.expired || item.superseded) && <Button variant="light" color="orange" onClick={onDiagnoseAgain}>Diagnose Again</Button>}</Group>
    <Card withBorder className={classes.section}><Stack><Title order={3} size="h4">Execution &amp; Validation History</Title>{item.executions.length ? item.executions.map((execution) => <ExecutionResult execution={execution} key={execution.id} />) : <Text c="dimmed">No executions have been attempted for this case.</Text>}</Stack></Card>
  </Stack>;
}

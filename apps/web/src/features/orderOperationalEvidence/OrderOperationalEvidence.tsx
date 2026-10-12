import { Accordion, Alert, Badge, Group, Pagination, SegmentedControl, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { ApiError } from "../../lib/api";
import { DataState, StatusBadge, formatStatusLabel } from "../../components/data-display";
import { useOrderOperationalEvidence } from "./hooks";
import type { BrokerOpportunity, ComparisonState, EvidenceAttempt, EvidenceGate, EvidenceState } from "./types";
import classes from "./OrderOperationalEvidence.module.css";

type Props = {
  orderIntentId: number | null;
  token: string | null;
  authorizationContext: string;
  expectedTradingAccountId?: number | null;
  enabled?: boolean;
};

const DIMENSIONS = ["TREND", "VOLATILITY", "BREADTH", "PARTICIPATION", "INTRADAY_STRESS"] as const;

export function OrderOperationalEvidence({ orderIntentId, token, authorizationContext, expectedTradingAccountId, enabled = true }: Props) {
  const identity = `${authorizationContext}:${orderIntentId ?? "none"}`;
  const [pageSelection, setPageSelection] = useState({ identity, page: 1 });
  const opportunityPage = pageSelection.identity === identity ? pageSelection.page : 1;
  const query = useOrderOperationalEvidence(orderIntentId, opportunityPage, token, authorizationContext, enabled);
  const [opportunitySelection, setOpportunitySelection] = useState<{ identity: string; id: number | null }>({ identity, id: null });
  const selectedOpportunityId = opportunitySelection.identity === identity ? opportunitySelection.id : null;

  if (!orderIntentId) return <DataState state="empty" title="No OrderIntent" message="This Entry Decision did not create an OrderIntent, so no order-level Market Policy evidence exists." />;
  if (query.isLoading) return <DataState state="loading" message="Loading immutable order evidence…" />;
  if (query.isError) {
    const status = query.error instanceof ApiError ? query.error.status : null;
    const unavailable = status === 403 || status === 404;
    return <DataState state="error" title={unavailable ? "Order evidence unavailable" : "Unable to load order evidence"} message={unavailable ? "The OrderIntent does not exist or is not available within your authorized Trading Accounts." : query.error.message} onRetry={unavailable ? undefined : () => void query.refetch()} />;
  }
  const data = query.data;
  if (!data) return <DataState state="empty" title="No evidence response" message="No operational evidence was returned for this OrderIntent." />;
  if (expectedTradingAccountId != null && data.orderIntent.tradingAccountId !== expectedTradingAccountId) {
    return <Alert color="red" title="Account context mismatch">The returned OrderIntent does not belong to the Entry Decision's Trading Account. Evidence has been hidden.</Alert>;
  }
  const opportunity = data.brokerStage.opportunities.find(item => item.id === selectedOpportunityId) ?? data.brokerStage.opportunities[0] ?? null;
  const intentAttempt = data.intentStage.comparison.attempts.at(-1) ?? null;
  const brokerAttempt = opportunity?.comparison.attempts.at(-1) ?? null;
  const assignment = data.orderIntent.assignment;

  return <Stack gap="md" data-testid="order-operational-evidence">
    <Alert color="grape" title="COMPARE ONLY · NO TRADING EFFECT">
      Market Policy results are immutable observations. They did not allow, reject, cancel, retry, or modify this order. The authoritative OrderIntent status remains <strong>{formatStatusLabel(data.orderIntent.status)}</strong>.
    </Alert>

    <section className={classes.section}>
      <Title order={3} size="h5" mb="sm">Order lifecycle</Title>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Fact label="OrderIntent" value={`#${data.orderIntent.id} · ${formatStatusLabel(data.orderIntent.status)}`} />
        <Fact label="Trading Account" value={data.orderIntent.tradingAccount ? `${data.orderIntent.tradingAccount.displayName} · ${data.orderIntent.tradingAccount.environment}` : `Account ${data.orderIntent.tradingAccountId ?? "unassigned"}`} />
        <Fact label="Order" value={`${data.orderIntent.symbol} · ${formatStatusLabel(data.orderIntent.side)} · ${formatStatusLabel(data.orderIntent.orderType)}`} />
        <Fact label="Created" value={dateTime(data.orderIntent.createdAt)} />
        <Fact label="Assignment" value={assignment ? `#${assignment.id}` : "Not recorded"} />
        <Fact label="Subscription" value={assignment?.subscription ? `${assignment.subscription.name} · ${assignment.subscription.key}` : data.orderIntent.subscriptionKey ?? "Not recorded"} />
        <Fact label="Strategy" value={assignment?.subscription.strategy ? `${assignment.subscription.strategy.name} · ${assignment.subscription.strategy.key}` : "Not recorded"} />
        <Fact label="Broker / position" value={`${data.orderIntent.brokerOrders.length} broker order${data.orderIntent.brokerOrders.length === 1 ? "" : "s"} · ${data.orderIntent.trackedPosition ? `position #${data.orderIntent.trackedPosition.id} ${formatStatusLabel(data.orderIntent.trackedPosition.status)}` : "no tracked position"}`} />
      </SimpleGrid>
    </section>

    <section className={classes.section}>
      <Group justify="space-between" align="flex-start" mb="sm"><div><Title order={3} size="h5">Intent-time evidence</Title><Text size="sm" c="dimmed">Frozen when the OrderIntent was created.</Text></div><StateBadge state={data.intentStage.state} /></Group>
      <CoverageState state={data.intentStage.state} />
      {data.intentStage.coverage && <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
        <Fact label="Captured" value={dateTime(data.intentStage.coverage.capturedAt)} />
        <Fact label="Provenance" value={formatStatusLabel(data.intentStage.coverage.provenance)} />
        <Fact label="Enrollment generation" value={data.intentStage.coverage.enrollmentGeneration ? `${data.intentStage.coverage.enrollmentGeneration.generation} · ${formatStatusLabel(data.intentStage.coverage.enrollmentGeneration.status)}` : "Not applicable"} />
        <Fact label="Bound policy revision" value={data.intentStage.coverage.boundPolicyRevision ? `${data.intentStage.coverage.boundPolicyRevision.revision} · ${formatStatusLabel(data.intentStage.coverage.boundPolicyRevision.status)}` : "Not applicable"} />
        <Fact label="Composition" value={data.intentStage.coverage.marketComposition ? `#${data.intentStage.coverage.marketComposition.id} · ${data.intentStage.coverage.marketComposition.compositionVersion}` : "None visible"} />
        <Fact label="Composition observed" value={dateTime(data.intentStage.coverage.marketComposition?.observedAt ?? null)} />
        <Fact label="Evidence through" value={dateTime(data.intentStage.coverage.marketComposition?.dataThroughAt ?? null)} />
        <Fact label="Valid until" value={dateTime(data.intentStage.coverage.marketComposition?.validUntil ?? null)} />
      </SimpleGrid>}
      <ComparisonSummary title="Intent-time comparison" comparisonState={data.intentStage.comparison.state} attempt={intentAttempt} />
      <GatePresentation attempt={intentAttempt} comparisonState={data.intentStage.comparison.state} compositionCapture={data.intentStage.coverage?.compositionCapture ?? null} />
    </section>

    <section className={classes.section}>
      <Group justify="space-between" align="flex-start" mb="sm"><div><Title order={3} size="h5">Broker POST opportunity comparison</Title><Text size="sm" c="dimmed">An opportunity capture is not proof that an order was dispatched or accepted.</Text></div><Badge variant="light">{formatStatusLabel(data.brokerStage.state)}</Badge></Group>
      {data.brokerStage.opportunities.length === 0 ? <BrokerAbsence state={data.brokerStage.state} /> : <Stack gap="sm">
        {data.brokerStage.opportunities.length > 1 && <SegmentedControl fullWidth value={String(opportunity?.id ?? "")} onChange={value => setOpportunitySelection({ identity, id: Number(value) })} data={data.brokerStage.opportunities.map(item => ({ value: String(item.id), label: `Opportunity ${item.opportunitySequence}` }))} />}
        {opportunity && <OpportunitySummary opportunity={opportunity} attempt={brokerAttempt} />}
        {data.brokerStage.pagination.totalPages > 1 && <><Text size="xs" c="dimmed">Showing opportunity page {data.brokerStage.pagination.page} of {data.brokerStage.pagination.totalPages} · {data.brokerStage.pagination.total} total. Additional pages are not implied to be loaded.</Text><Pagination value={opportunityPage} total={data.brokerStage.pagination.totalPages} onChange={page => setPageSelection({ identity, page })} size="sm" /></>}
      </Stack>}
    </section>

    <Accordion variant="contained">
      <Accordion.Item value="provenance"><Accordion.Control>Technical provenance</Accordion.Control><Accordion.Panel><SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Fact label="Capture schema" value={data.intentStage.coverage?.captureSchemaVersion ?? "Not captured"} technical />
        <Fact label="Intent evaluation version" value={intentAttempt?.evaluationVersion ?? "Not evaluated"} technical />
        <Fact label="Intent reason code" value={intentAttempt?.reasonCode ?? data.intentStage.comparison.delivery?.lastErrorCode ?? "Not recorded"} technical />
        <Fact label="Composition ID" value={data.intentStage.coverage?.marketRegimeAssessmentId ?? "None"} technical />
        {data.intentStage.coverage?.marketComposition?.sourceSetFingerprint !== undefined && <Fact label="Source fingerprint" value={data.intentStage.coverage.marketComposition.sourceSetFingerprint} technical />}
        <Fact label="Comparison authority" value={`${data.authority.comparisonMode} · tradingEffect ${data.authority.tradingEffect}`} technical />
        <Fact label="Attempt bounds" value={`${data.intentStage.comparison.attemptBounds.returned}/${data.intentStage.comparison.attemptBounds.total} returned`} technical />
        <Fact label="Related records" value={`EntryDecision ${data.relatedRecords.entryDecisionId ?? "none"} · BrokerOrder ${data.relatedRecords.brokerOrderRecordIds.join(", ") || "none"} · Position ${data.relatedRecords.trackedPositionId ?? "none"}`} technical />
      </SimpleGrid></Accordion.Panel></Accordion.Item>
    </Accordion>
  </Stack>;
}

function OpportunitySummary({ opportunity, attempt }: { opportunity: BrokerOpportunity; attempt: EvidenceAttempt | null }) {
  return <Stack gap="sm"><SimpleGrid cols={{ base: 1, sm: 2 }}>
    <Fact label="Opportunity" value={`Sequence ${opportunity.opportunitySequence} · ${dateTime(opportunity.opportunityAt)}`} />
    <Fact label="Applicability" value={formatStatusLabel(opportunity.applicability)} />
    <Fact label="Composition" value={opportunity.marketRegimeAssessmentId ? `#${opportunity.marketRegimeAssessmentId} · ${formatStatusLabel(opportunity.compositionCapture)}` : formatStatusLabel(opportunity.compositionCapture)} />
    <Fact label="Comparison" value={formatStatusLabel(opportunity.comparison.state)} />
  </SimpleGrid><ComparisonSummary title="Broker-time comparison" comparisonState={opportunity.comparison.state} attempt={attempt} /><GatePresentation attempt={attempt} comparisonState={opportunity.comparison.state} compositionCapture={opportunity.compositionCapture} />
  {opportunity.sourceSetFingerprint !== undefined && <Text size="xs" c="dimmed" className={classes.technical}>Source fingerprint: {opportunity.sourceSetFingerprint ?? "none"}</Text>}</Stack>;
}

function ComparisonSummary({ title, comparisonState, attempt }: { title: string; comparisonState: ComparisonState; attempt: EvidenceAttempt | null }) {
  return <Group mt="md" gap="xs" align="center"><Text size="sm" fw={700}>{title}</Text><StatusBadge status={attempt?.outcome ?? comparisonState} label={formatStatusLabel(attempt?.outcome ?? comparisonState)} tone={attempt?.outcome === "ALLOWED" ? "positive" : attempt?.outcome === "BLOCKED" ? "warning" : comparisonState === "TECHNICAL_FAILURE" || comparisonState === "TERMINAL_RETRY_EXHAUSTED" ? "danger" : "neutral"} /><Text size="xs" c="dimmed">{attempt ? `${formatStatusLabel(attempt.reasonCode)} · evidence as of ${dateTime(attempt.evidenceAsOf)}` : comparisonMessage(comparisonState)}</Text></Group>;
}

export function GatePresentation({ attempt, comparisonState, compositionCapture }: { attempt: EvidenceAttempt | null; comparisonState: ComparisonState; compositionCapture: string | null }) {
  if (!attempt || attempt.gates.length === 0) {
    const noneVisible = compositionCapture === "NONE_VISIBLE";
    return <Alert mt="sm" color={comparisonState === "TECHNICAL_FAILURE" || comparisonState === "TERMINAL_RETRY_EXHAUSTED" ? "red" : "gray"} title={noneVisible ? "No composition visible" : comparisonState === "PENDING" ? "Comparison pending" : "No gate evidence"}>{noneVisible ? "This is a valid zero-gate result. No dimension rows are fabricated." : comparisonMessage(comparisonState)}</Alert>;
  }
  const gates = [...attempt.gates].sort((a, b) => DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension));
  return <div className={classes.gateGrid}>{gates.map(gate => <GateCard gate={gate} evidenceAsOf={attempt.evidenceAsOf} key={gate.id} />)}</div>;
}

function GateCard({ gate, evidenceAsOf }: { gate: EvidenceGate; evidenceAsOf: string }) {
  return <section className={classes.section}><Group justify="space-between" align="flex-start"><div><Text fw={700}>{formatStatusLabel(gate.dimension)}</Text><Text size="xs" c="dimmed">{gate.algorithmVersion}</Text></div><Group gap={4}><Badge size="xs" variant="outline">{gate.requirement}</Badge><StatusBadge status={gate.outcome} label={formatStatusLabel(gate.outcome)} size="compact" /></Group></Group><SimpleGrid cols={2} mt="xs">
    <Fact label="Observed" value={gate.observedState ? formatStatusLabel(gate.observedState) : "Unavailable"} />
    <Fact label="Source" value={`${formatStatusLabel(gate.sourceHealth ?? "UNAVAILABLE")} · #${gate.sourceAssessmentId ?? "none"}`} />
    {gate.allowedStates !== undefined && <Fact label="Allowed states" value={gate.allowedStates.length ? gate.allowedStates.map(formatStatusLabel).join(", ") : "None"} />}
    <Fact label="Reason" value={formatStatusLabel(gate.reasonCode)} />
  </SimpleGrid><Text size="xs" c="dimmed" mt="xs">Evidence as of {dateTime(evidenceAsOf)}</Text></section>;
}

function CoverageState({ state }: { state: EvidenceState }) { return <Text size="sm" c="dimmed">{({ PRE_ROLLOUT: "Observation was unavailable by design because this order predates the capture rollout.", POST_EPOCH_MISSING_CAPTURE: "Capture was expected after rollout, but evidence is missing. This indicates an instrumentation gap.", UNENROLLED: "No applicable assignment enrollment existed at intent creation.", LEGACY_UNKNOWN: "Coverage is legacy or unknown and was not reconstructed from current configuration.", EXACT: "An exact frozen composition and assignment identity were captured.", NONE_VISIBLE: "Coverage was captured, but no market composition was visible at that time." } satisfies Record<EvidenceState, string>)[state]}</Text>; }
function BrokerAbsence({ state }: { state: string }) { return <Alert color={state === "MISSING_OBSERVATION" ? "yellow" : "gray"} title={state === "MISSING_OBSERVATION" ? "Broker observation missing" : "No broker POST opportunity"}>{state === "BROKER_LOOKUP_FOUND_WITHOUT_NEW_POST" ? "A broker order was found during lookup, so no genuinely new POST opportunity was captured. This label is derived from lifecycle facts." : state === "MISSING_OBSERVATION" ? "Instrumentation recorded missing broker-boundary observation evidence." : "No broker POST opportunity evidence exists for this OrderIntent."}</Alert>; }
function StateBadge({ state }: { state: EvidenceState }) { return <Badge color={state === "POST_EPOCH_MISSING_CAPTURE" ? "red" : state === "EXACT" ? "teal" : state === "NONE_VISIBLE" ? "blue" : "gray"}>{formatStatusLabel(state)}</Badge>; }
function Fact({ label, value, technical = false }: { label: string; value: ReactNode; technical?: boolean }) { return <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text><Text size="sm" className={technical ? classes.technical : undefined}>{value}</Text></div>; }
function comparisonMessage(state: ComparisonState) { return ({ NOT_SCHEDULED: "No comparison delivery was scheduled for this evidence.", PENDING: "Comparison is pending or waiting for a bounded retry.", COMPLETED: "The immutable comparison completed.", INSUFFICIENT_EVIDENCE: "The evaluator recorded insufficient evidence.", TECHNICAL_FAILURE: "The evaluator recorded a technical failure.", TERMINAL_RETRY_EXHAUSTED: "The comparison exhausted its bounded delivery retries." } satisfies Record<ComparisonState, string>)[state]; }
function dateTime(value: string | null) { if (!value) return "Not recorded"; const date = new Date(value); return Number.isNaN(date.getTime()) ? "Not recorded" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }

import { Accordion, Alert, Badge, Group, Pagination, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { useState, type ReactNode } from "react";
import { ApiError } from "../../lib/api";
import { DataState, StatusBadge, formatStatusLabel } from "../../components/data-display";
import { useOrderOperationalEvidence } from "./hooks";
import type { BrokerOpportunity, BrokerOpportunityEvent, ComparisonState, EvidenceAttempt, EvidenceGate, EvidenceState } from "./types";
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
  const [eventPageSelection, setEventPageSelection] = useState({ identity, page: 1 });
  const eventPage = eventPageSelection.identity === identity ? eventPageSelection.page : 1;
  const query = useOrderOperationalEvidence(orderIntentId, opportunityPage, eventPage, token, authorizationContext, enabled);

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
  const intentAttempt = data.intentStage.comparison.attempts.at(-1) ?? null;
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
      {data.brokerStage.opportunities.length === 0 ? <><BrokerAbsence state={data.brokerStage.state} />{data.brokerStage.unboundMissingObservations.length > 0 && <LifecycleTimeline events={data.brokerStage.unboundMissingObservations} title="Unbound observation events" />}</> : <Stack gap="sm">
        <Accordion variant="separated" defaultValue={String(data.brokerStage.opportunities[0]?.id)}>{data.brokerStage.opportunities.map(opportunity => <Accordion.Item value={String(opportunity.id)} key={opportunity.id}><Accordion.Control><Group justify="space-between" wrap="nowrap"><div><Text fw={700}>Opportunity {opportunity.opportunitySequence}</Text><Text size="xs" c="dimmed">{dateTime(opportunity.opportunityAt)} · capture is not submission</Text></div><StatusBadge status={opportunity.comparison.attempts.at(-1)?.outcome ?? opportunity.comparison.state} label={formatStatusLabel(opportunity.comparison.attempts.at(-1)?.outcome ?? opportunity.comparison.state)} size="compact" /></Group></Accordion.Control><Accordion.Panel><OpportunitySummary opportunity={opportunity} attempt={opportunity.comparison.attempts.at(-1) ?? null} eventPage={eventPage} onEventPageChange={page => setEventPageSelection({ identity, page })} /></Accordion.Panel></Accordion.Item>)}</Accordion>
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

function OpportunitySummary({ opportunity, attempt, eventPage, onEventPageChange }: { opportunity: BrokerOpportunity; attempt: EvidenceAttempt | null; eventPage: number; onEventPageChange: (page: number) => void }) {
  return <Stack gap="sm"><SimpleGrid cols={{ base: 1, sm: 2 }}>
    <Fact label="Opportunity" value={`Sequence ${opportunity.opportunitySequence} · ${dateTime(opportunity.opportunityAt)}`} />
    <Fact label="Applicability" value={formatStatusLabel(opportunity.applicability)} />
    <Fact label="Composition" value={opportunity.marketRegimeAssessmentId ? `#${opportunity.marketRegimeAssessmentId} · ${formatStatusLabel(opportunity.compositionCapture)}` : formatStatusLabel(opportunity.compositionCapture)} />
    <Fact label="Frozen policy revision" value={opportunity.policyRevisionId ? `#${opportunity.policyRevisionId}` : "Not applicable"} />
    <Fact label="Comparison" value={formatStatusLabel(opportunity.comparison.state)} />
  </SimpleGrid><ComparisonSummary title="Broker-time comparison" comparisonState={opportunity.comparison.state} attempt={attempt} /><GatePresentation attempt={attempt} comparisonState={opportunity.comparison.state} compositionCapture={opportunity.compositionCapture} />
  <LifecycleTimeline events={opportunity.events} relatedBrokerOrders={opportunity.relatedBrokerOrders} />
  {opportunity.eventPagination.totalPages > 1 && <Group justify="space-between"><Text size="xs" c="dimmed">Event page {opportunity.eventPagination.page} of {opportunity.eventPagination.totalPages}; later pages are not included here.</Text><Pagination value={eventPage} total={opportunity.eventPagination.totalPages} onChange={onEventPageChange} size="xs" /></Group>}
  {opportunity.sourceSetFingerprint !== undefined && <Text size="xs" c="dimmed" className={classes.technical}>Source fingerprint: {opportunity.sourceSetFingerprint ?? "none"}</Text>}</Stack>;
}

function LifecycleTimeline({ events, relatedBrokerOrders = [], title = "Broker delivery timeline" }: { events: BrokerOpportunityEvent[]; relatedBrokerOrders?: BrokerOpportunity["relatedBrokerOrders"]; title?: string }) {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence || a.id - b.id);
  if (ordered.length === 0) return <Alert color="gray" title="Captured opportunity without dispatch evidence">No immutable lifecycle event beyond the opportunity record is available. This does not prove broker submission.</Alert>;
  return <section><Text fw={700} size="sm" mb="xs">{title}</Text><Alert mb="sm" color="gray" title="Derived lifecycle summary">{derivedLifecycleSummary(ordered)} This summary is derived only from the recorded events below.</Alert><Stack gap={0} className={classes.timeline}>{ordered.map(event => <div className={classes.timelineEvent} key={event.id}><div className={classes.timelineMarker} /><div><Group gap="xs"><Text fw={700} size="sm">{formatStatusLabel(event.eventType)}</Text><Badge size="xs" color={eventTone(event.eventType)} variant="light">{eventCertainty(event.eventType)}</Badge></Group><Text size="xs" c="dimmed">Sequence {event.sequence} · occurred {dateTime(event.occurredAt)} · recorded {dateTime(event.createdAt)}</Text><Text size="sm">{eventDescription(event)}</Text>{event.details?.brokerOrderId && <Text size="xs" className={classes.technical}>Broker order {event.details.brokerOrderId}{event.details.brokerStatus ? ` · ${formatStatusLabel(event.details.brokerStatus)}` : ""}</Text>}</div></div>)}</Stack>{relatedBrokerOrders.length > 0 && <Alert mt="sm" color="teal" title="Broker order materialized">{relatedBrokerOrders.map(order => <Text size="sm" key={order.id}>Local BrokerOrder #{order.id} · {order.brokerOrderId} · {formatStatusLabel(order.status)}</Text>)}</Alert>}</section>;
}

function eventCertainty(type: BrokerOpportunityEvent["eventType"]) { if (type === "OPPORTUNITY_CAPTURED") return "Opportunity only"; if (type === "ADAPTER_DISPATCH_REACHED") return "Dispatch reached"; if (type === "BROKER_RESPONSE_CONFIRMED" || type === "BROKER_REJECTED") return "Broker response"; if (type === "BROKER_ORDER_MATERIALIZED" || type === "RECOVERY_FOUND") return "Order established"; if (type === "DEFINITELY_NOT_SENT" || type === "DEFERRED" || type === "RECOVERY_ABSENCE_CONFIRMED") return "Not sent"; if (type === "DELIVERY_UNCERTAIN" || type === "RECOVERY_INCONCLUSIVE") return "Uncertain"; return "Observation gap"; }
function eventTone(type: BrokerOpportunityEvent["eventType"]) { return type === "BROKER_ORDER_MATERIALIZED" || type === "RECOVERY_FOUND" || type === "BROKER_RESPONSE_CONFIRMED" ? "teal" : type === "DELIVERY_UNCERTAIN" || type === "RECOVERY_INCONCLUSIVE" || type === "MISSING_OBSERVATION" ? "orange" : type === "BROKER_REJECTED" ? "red" : "gray"; }
function derivedLifecycleSummary(events: BrokerOpportunityEvent[]) { const types = new Set(events.map(event => event.eventType)); if (types.has("BROKER_ORDER_MATERIALIZED") || types.has("RECOVERY_FOUND")) return "A broker order was established."; if (types.has("BROKER_REJECTED")) return "The broker returned a rejection."; if (types.has("BROKER_RESPONSE_CONFIRMED")) return "A broker response was confirmed."; if (types.has("DELIVERY_UNCERTAIN")) return "Delivery remains uncertain."; if (types.has("RECOVERY_INCONCLUSIVE")) return "Recovery was inconclusive."; if (types.has("RECOVERY_ABSENCE_CONFIRMED")) return "Recovery confirmed absence; any later opportunity is a separate event sequence."; if (types.has("DEFINITELY_NOT_SENT")) return "The request was definitely not sent."; if (types.has("DEFERRED")) return "Submission was deferred."; if (types.has("ADAPTER_DISPATCH_REACHED")) return "Dispatch reached the adapter, but broker receipt is not confirmed."; if (types.has("OPPORTUNITY_CAPTURED")) return "An opportunity was captured without dispatch evidence."; return "Observation evidence is missing."; }
function eventDescription(event: BrokerOpportunityEvent) { const detail = event.details; return ({ OPPORTUNITY_CAPTURED: "A genuine broker POST opportunity was captured. No dispatch is implied.", ADAPTER_DISPATCH_REACHED: "Execution reached the broker adapter boundary. Broker receipt is not confirmed.", BROKER_RESPONSE_CONFIRMED: "A broker response was confirmed independently of the comparison result.", BROKER_REJECTED: `The broker rejected the request${detail?.statusCode ? ` (HTTP ${detail.statusCode})` : ""}.`, BROKER_ORDER_MATERIALIZED: "A BrokerOrder identity was established from persisted lifecycle evidence.", DELIVERY_UNCERTAIN: `Delivery may have occurred, but broker receipt was not confirmed${detail?.classification ? ` (${formatStatusLabel(detail.classification)})` : ""}.`, DEFINITELY_NOT_SENT: "The request was classified as definitely not sent.", DEFERRED: "Submission was deferred before a confirmed broker response.", RECOVERY_FOUND: "Later recovery found the broker order.", RECOVERY_ABSENCE_CONFIRMED: "Recovery confirmed absence before any later fresh opportunity.", RECOVERY_INCONCLUSIVE: "Recovery could not determine whether the broker received the order.", MISSING_OBSERVATION: "Broker-boundary instrumentation failed to persist the expected observation." } satisfies Record<BrokerOpportunityEvent["eventType"], string>)[event.eventType]; }

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

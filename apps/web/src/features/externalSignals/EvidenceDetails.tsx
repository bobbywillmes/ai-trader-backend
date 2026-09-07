import { Button, Group, Stack, Text } from "@mantine/core";
import { RecordDetailsGrid } from "../../components/data-display";
import { CopyValue, EvidenceBadge, JsonEvidence, StrategyLink } from "./components";
import { useCatalogs } from "./hooks";
import { stamp } from "./presentation";
import type { Delivery, Signal } from "./types";

type Navigate = (values: Record<string, string | null>) => void;
export function SignalDetails({ signal, token, navigate }: { signal: Signal; token: string | null; navigate: Navigate }) {
  const catalogs = useCatalogs(token);
  return <Stack gap="lg">
    <Group><Text fw={700}>{signal.symbol}</Text><EvidenceBadge value={signal.event} /><Text size="sm">{signal.timeframe}</Text></Group>
    <Text size="sm" c="dimmed">Immutable canonical evidence. This event has no execution authority.</Text>
    <RecordDetailsGrid sections={[{ title: "Strategy event", items: [
      { label: "Signal ID", value: signal.id }, { label: "Source", value: catalogs.sourceName(signal.signalSourceId) },
      { label: "Source ID", value: signal.signalSourceId },
      { label: "Strategy binding", value: <Button size="compact-xs" variant="subtle" onClick={() => navigate({ section: "bindings", detail: String(signal.strategySignalBindingId) })}>Binding #{signal.strategySignalBindingId}</Button> },
      { label: "Strategy", value: <StrategyLink id={signal.strategyId} name={catalogs.strategyName(signal.strategyId)} /> },
      { label: "Strategy ID", value: signal.strategyId }, { label: "Security / symbol", value: `${signal.symbol} · Security #${signal.securityId}` },
      { label: "Schema version", value: signal.schemaVersion }, { label: "Strategy revision", value: signal.strategyRevision },
    ] }, { title: "Timestamps", items: [
      { label: "Signal time", value: stamp(signal.signalTime) }, { label: "Bar time", value: stamp(signal.barTime) }, { label: "Created", value: stamp(signal.createdAt) },
    ] }]} />
    <section><Text size="sm" fw={600} mb="xs">External event key</Text><CopyValue value={signal.externalEventKey} name="event key" /></section>
    <section><Text size="sm" fw={600} mb="xs">Canonical payload hash</Text><CopyValue value={signal.canonicalPayloadHash} name="canonical hash" /></section>
    <JsonEvidence title="Metadata" value={signal.metadata} />
    <Button variant="light" onClick={() => navigate({ section: "deliveries", signalId: String(signal.id), detail: null })}>View related deliveries</Button>
  </Stack>;
}
export function DeliveryDetails({ delivery, token, navigate }: { delivery: Delivery; token: string | null; navigate: Navigate }) {
  const catalogs = useCatalogs(token);
  return <Stack gap="lg">
    <Group><Text fw={700}>Delivery #{delivery.id}</Text><EvidenceBadge value={delivery.status} /></Group>
    <Text size="sm" c="dimmed">Immutable transport and processing evidence. Payload credentials have been redacted by the backend.</Text>
    <RecordDetailsGrid sections={[{ title: "Processing", items: [
      { label: "Source", value: catalogs.sourceName(delivery.signalSourceId) }, { label: "Source ID", value: delivery.signalSourceId },
      { label: "Linked Signal", value: delivery.signalId ? <Button variant="subtle" size="compact-xs" onClick={() => navigate({ section: "signals", detail: String(delivery.signalId) })}>View Signal #{delivery.signalId}</Button> : "No Signal — delivery was not normalized" },
      { label: "Received", value: stamp(delivery.receivedAt) }, { label: "Processed", value: stamp(delivery.processedAt) }, { label: "Created", value: stamp(delivery.createdAt) },
      { label: "Content type", value: delivery.contentType ?? "Not retained" }, { label: "Body size", value: `${delivery.bodySizeBytes.toLocaleString()} bytes` },
      { label: "Rejection code", value: delivery.rejectionCode ?? "None" },
    ] }]} />
    <section><Text size="sm" fw={600} mb="xs">Request ID</Text><CopyValue value={delivery.requestId} name="request ID" /></section>
    <section><Text size="sm" fw={600} mb="xs">Raw payload hash</Text><CopyValue value={delivery.rawPayloadHash} name="raw hash" /></section>
    <JsonEvidence title="Redacted raw payload" value={delivery.rawPayloadRedacted} />
    {delivery.rejectionDetails != null && typeof delivery.rejectionDetails === 'object' && Object.keys(delivery.rejectionDetails).length > 0 &&
      <JsonEvidence title="Rejection details" value={delivery.rejectionDetails} />}
  </Stack>;
}

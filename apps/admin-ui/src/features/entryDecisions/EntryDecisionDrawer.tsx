import type { ReactNode } from "react";
import {
  Alert,
  Badge,
  Code,
  Divider,
  Drawer,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconFileAnalytics } from "@tabler/icons-react";
import { TradingAccountBadge } from "../../components/TradingAccountBadge";
import type { EntryDecisionDetail, EntryDecisionRelatedRecord } from "./types";

type EntryDecisionDrawerProps = {
  opened: boolean;
  decision: EntryDecisionDetail | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onClose: () => void;
};

export function EntryDecisionDrawer({
  opened,
  decision,
  isLoading,
  isError,
  error,
  onClose,
}: EntryDecisionDrawerProps) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        decision ? (
          <Group gap="sm">
            <IconFileAnalytics size={20} />
            <Text fw={700}>
              {decision.symbol} Decision #{decision.id}
            </Text>
          </Group>
        ) : (
          "Entry Decision"
        )
      }
    >
      {isLoading && (
        <Group>
          <Loader size="sm" />
          <Text c="dimmed">Loading decision snapshot...</Text>
        </Group>
      )}

      {isError && (
        <Alert color="red" title="Failed to load entry decision">
          {error?.message ?? "Check the backend route and admin session."}
        </Alert>
      )}

      {decision && (
        <Stack gap="lg">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Info
              label="Trading Account"
              value={
                <TradingAccountBadge
                  account={decision.tradingAccount}
                  tradingAccountId={decision.tradingAccountId}
                />
              }
            />
            <Info
              label="Decision State"
              value={<DecisionBadge state={decision.decisionState} />}
            />
            <Info
              label="Signal Outcome"
              value={<SignalOutcome decision={decision} />}
            />
            <Info label="Evaluated" value={formatDate(decision.evaluatedAt)} />
            <Info label="Persisted" value={decision.persistenceReason} />
            <Info label="Source" value={decision.source} />
            <Info label="Market Session" value={decision.marketSession ?? "-"} />
          </SimpleGrid>

          <Divider />

          <Stack gap="xs">
            <Title order={3} size="h4">
              Decision Context
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Metric label="Current Price" value={formatMoney(decision.currentPrice)} />
              <Metric label="Previous Close" value={formatMoney(decision.previousClose)} />
              <Metric label="Day Low" value={formatMoney(decision.dayLow)} />
              <Metric label="Day Change" value={formatPercent(decision.dayChangePercent)} />
              <Metric label="Dip" value={formatPercent(decision.dipPercent)} />
              <Metric
                label="Dip Threshold"
                value={formatPercent(decision.dipThresholdPercent)}
              />
              <Metric
                label="Retrace Fraction"
                value={formatNumber(decision.retraceFraction)}
              />
              <Metric
                label="Minutes Since Signal"
                value={formatNumber(decision.minutesSinceLastSignal)}
              />
            </SimpleGrid>
          </Stack>

          <Divider />

          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Info label="Decision Reason" value={decision.decisionReason ?? "-"} />
            <Info label="Blocking Reason" value={decision.blockingReason ?? "-"} />
            <Info label="Signal Action" value={decision.signalAction ?? "-"} />
            <Info
              label="Cooldown"
              value={
                decision.cooldownActive
                  ? `Active until ${formatDate(decision.cooldownUntil)}`
                  : "Inactive"
              }
            />
            <Info
              label="Runtime"
              value={
                <Group gap={6}>
                  <BooleanBadge label="Trading" value={decision.tradingEnabled} />
                  <BooleanBadge label="Kill" value={decision.killSwitchEnabled} />
                  <BooleanBadge label="Paper" value={decision.paperMode} />
                </Group>
              }
            />
            <Info
              label="Automation"
              value={
                <Group gap={6}>
                  <BooleanBadge label="Orders" value={decision.allowOrderSignals} />
                  <BooleanBadge label="Dry Run" value={decision.dryRun} />
                </Group>
              }
            />
          </SimpleGrid>

          <Divider />

          <Stack gap="xs">
            <Title order={3} size="h4">
              Lifecycle Links
            </Title>
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <Related label="Security" record={decision.security} fallback={decision.symbol} />
              <Related
                label="Subscription"
                record={decision.subscription}
                fallback={decision.subscriptionKey}
              />
              <Related
                label="Strategy"
                record={decision.strategy}
                fallback={decision.strategyKey}
              />
              <Related
                label="Exit Profile"
                record={decision.exitProfile}
                fallback={decision.exitProfileKey}
              />
              <Related
                label="Order Intent"
                record={decision.orderIntent}
                fallback={decision.orderIntentId}
              />
              <Related
                label="Broker Order"
                record={decision.brokerOrderRecord}
                fallback={decision.brokerOrderRecordId}
              />
              <Related
                label="Tracked Position"
                record={decision.trackedPosition}
                fallback={decision.trackedPositionId}
              />
            </SimpleGrid>
          </Stack>

          <Divider />

          <Stack gap="xs">
            <Title order={3} size="h4">
              Snapshot Payloads
            </Title>
            <Payload label="Market" payload={decision.marketSnapshotJson} />
            <Payload label="Runtime" payload={decision.runtimeSnapshotJson} />
            <Payload label="Strategy" payload={decision.strategySnapshotJson} />
            <Payload label="Indicators" payload={decision.indicatorSnapshotJson} />
            <Payload label="Raw Decision" payload={decision.rawDecisionJson} />
          </Stack>
        </Stack>
      )}
    </Drawer>
  );
}

function DecisionBadge({ state }: { state: string }) {
  return (
    <Badge color={decisionColor(state)} variant="light">
      {state}
    </Badge>
  );
}

function SignalOutcome({ decision }: { decision: EntryDecisionDetail }) {
  if (decision.signalCreated) {
    return <Badge color="teal">Signal Created</Badge>;
  }

  if (decision.signalBlocked) {
    return <Badge color="red">Signal Blocked</Badge>;
  }

  if (decision.signalEligible === true) {
    return <Badge color="blue">Eligible</Badge>;
  }

  if (decision.signalEligible === false) {
    return <Badge color="gray">Not Eligible</Badge>;
  }

  return <Badge color="gray">Recorded</Badge>;
}

function BooleanBadge({
  label,
  value,
}: {
  label: string;
  value: boolean | null;
}) {
  if (value === null) {
    return (
      <Badge size="sm" color="gray" variant="light">
        {label}: -
      </Badge>
    );
  }

  return (
    <Badge size="sm" color={value ? "teal" : "red"} variant="light">
      {label}: {value ? "On" : "Off"}
    </Badge>
  );
}

function Related({
  label,
  record,
  fallback,
}: {
  label: string;
  record: EntryDecisionRelatedRecord | null;
  fallback: string | number | null;
}) {
  const primary =
    record?.name ??
    record?.key ??
    record?.symbol ??
    record?.brokerOrderId ??
    (fallback === null ? null : String(fallback));

  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="sm" fw={600}>
        {primary ?? "-"}
      </Text>
      {record?.id !== undefined && (
        <Text size="xs" c="dimmed">
          ID {record.id}
        </Text>
      )}
      {record?.status && (
        <Badge size="xs" variant="light" color="gray">
          {record.status}
        </Badge>
      )}
    </div>
  );
}

function Payload({ label, payload }: { label: string; payload: unknown }) {
  if (payload === null || payload === undefined) {
    return (
      <Text size="sm" c="dimmed">
        {label}: no payload captured.
      </Text>
    );
  }

  return (
    <details>
      <summary>
        <Text span fw={700} size="sm">
          {label}
        </Text>
      </summary>
      <Code block mt="xs">
        {JSON.stringify(payload, null, 2)}
      </Code>
    </details>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text size="sm">{value}</Text>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
        {label}
      </Text>
      <Text fw={700}>{value}</Text>
    </div>
  );
}

function decisionColor(state: string) {
  if (state.includes("allow") || state.includes("eligible")) return "teal";
  if (state.includes("block") || state.includes("deny")) return "red";
  if (state.includes("watch") || state.includes("cooldown")) return "yellow";
  return "blue";
}

function formatDate(value: string | null) {
  if (!value) return "-";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "-";

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 4,
  });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";

  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}%`;
}


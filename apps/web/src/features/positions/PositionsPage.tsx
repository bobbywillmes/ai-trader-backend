import { Fragment, useMemo, useState } from "react";
import { Accordion, Button, Card, Group, Stack, Table, Text, Title } from "@mantine/core";
import { modals } from "@mantine/modals";
import { notifications } from "@mantine/notifications";
import { IconChevronDown, IconChevronUp, IconFileAnalytics, IconTrash } from "@tabler/icons-react";
import {
  CompactRecordList,
  DataState,
  DataTable,
  MobileRecordCard,
  RecordDetailsGrid,
  ResponsiveActions,
  ResponsiveDataView,
  ResponsiveDetails,
  StatusBadge,
  type StatusTone,
  type SummaryField,
} from "../../components/data-display";
import { getAdminToken } from "../../lib/api";
import { TradeCycleDrawer } from "../tradeHistory/TradeCycleDrawer";
import { useTradeCycleDrawer } from "../tradeHistory/hooks";
import { useClosePosition, useOpenPositions } from "./hooks";
import type { TrackedPosition } from "./types";
import classes from "./PositionsPage.module.css";

const MISSING_VALUE = "Not available";

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value);
}

function formatCurrency(value: number | null | undefined) {
  if (!finite(value)) return MISSING_VALUE;
  return (value as number).toLocaleString(undefined, {
    style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function formatPercent(value: number | null | undefined, signed = false) {
  if (!finite(value)) return MISSING_VALUE;
  const sign = signed && (value as number) > 0 ? "+" : "";
  return `${sign}${(value as number).toFixed(2)}%`;
}

export function ProfitLoss({ dollars, ratio }: { dollars: number | null | undefined; ratio: number | null | undefined }) {
  const available = finite(dollars) && finite(ratio);
  const tone = !available ? "unavailable" : (dollars as number) > 0 ? "positive" : (dollars as number) < 0 ? "negative" : "neutral";
  const sign = available && (dollars as number) > 0 ? "+" : "";
  return <span className={classes.pnl} data-pnl-tone={tone} aria-label={available ? `${tone} profit and loss, ${sign}${formatCurrency(dollars)}, ${formatPercent((ratio as number) * 100, true)}` : "Profit and loss unavailable"}>
    <span aria-hidden="true">{available ? `${sign}${formatCurrency(dollars)} · ${formatPercent((ratio as number) * 100, true)}` : MISSING_VALUE}</span>
  </span>;
}

function accountName(position: TrackedPosition) {
  return position.tradingAccount?.displayName ?? (position.tradingAccountId !== null ? `Account ${position.tradingAccountId}` : "Unassigned account");
}

function formatDate(value: string | null | undefined) {
  if (!value) return MISSING_VALUE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? MISSING_VALUE : date.toLocaleString();
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function attentionLabel(position: TrackedPosition) {
  switch (position.exitState?.attentionCode) {
    case "trail_submit_failed": return "Submit failed";
    case "trail_order_rejected": return "Rejected";
    case "trail_order_canceled": return "Canceled";
    case "trail_order_expired": return "Expired";
    default: return "Attention required";
  }
}

function needsAttention(position: TrackedPosition) {
  return Boolean(position.exitState?.attentionRequired);
}

function attentionMessage(position: TrackedPosition) {
  return position.exitState?.attentionMessage ?? (needsAttention(position) ? attentionLabel(position) : "None");
}

function exitProfile(position: TrackedPosition) {
  return position.subscription?.exitProfile ?? null;
}

function exitMode(position: TrackedPosition) {
  return position.exitState?.exitMode ?? exitProfile(position)?.exitMode ?? null;
}

function unlockTrailing(position: TrackedPosition) {
  return exitMode(position) === "unlock_trailing_stop";
}

function exitStrategy(position: TrackedPosition) {
  const mode = exitMode(position);
  const labels: Record<string, string> = {
    unlock_trailing_stop: "Target unlocks trail", fixed_target: "Fixed target", fixed_bracket: "Fixed bracket", hybrid: "Hybrid",
  };
  return mode ? labels[mode] ?? titleCase(mode) : MISSING_VALUE;
}

function targetPercent(position: TrackedPosition) {
  return position.exitState?.targetPct ?? exitProfile(position)?.targetPct ?? null;
}

function targetPrice(position: TrackedPosition) {
  const percent = targetPercent(position);
  if (!finite(percent) || !finite(position.avgEntryPrice)) return null;
  return position.side === "short"
    ? position.avgEntryPrice * (1 - (percent as number) / 100)
    : position.avgEntryPrice * (1 + (percent as number) / 100);
}

function conciseExitState(position: TrackedPosition) {
  if (needsAttention(position)) return attentionLabel(position);
  if (!unlockTrailing(position)) return exitStrategy(position);
  const status = position.exitState?.trailOrderStatus ?? position.trailingStopStatus;
  if (status === "filled") return "Trail filled";
  if (["canceled", "expired", "rejected", "suspended", "broker_order_not_found", "submit_failed"].includes(status ?? "")) return "Attention required";
  if (position.exitState?.trailBrokerOrderId || position.exitState?.trailClientOrderId || position.trailingStopOrderId) return "Trail active";
  if (position.exitState?.targetUnlocked || position.trailingUnlocked) return "Trail unlocked";
  return "Waiting for unlock";
}

function statusTone(position: TrackedPosition, isClosing: boolean): StatusTone {
  if (needsAttention(position)) return "danger";
  if (isClosing) return "warning";
  return position.status.toLowerCase() === "open" ? "positive" : "neutral";
}

function exitTone(position: TrackedPosition): StatusTone {
  if (needsAttention(position)) return "danger";
  const state = conciseExitState(position);
  if (state === "Trail active" || state === "Trail unlocked") return "informational";
  if (state === "Waiting for unlock") return "warning";
  return "neutral";
}

export function PositionsPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const positionsQuery = useOpenPositions(token);
  const positions = useMemo(() => positionsQuery.data ?? [], [positionsQuery.data]);
  const closeMutation = useClosePosition(token);
  const tradeCycleDrawer = useTradeCycleDrawer(token);
  const [expandedId, setExpandedId] = useState<string | number | null>(null);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detailOpener, setDetailOpener] = useState<HTMLElement | null>(null);
  const detailPosition = useMemo(() => positions.find((position) => position.id === detailId) ?? null, [detailId, positions]);
  const attentionCount = positions.filter(needsAttention).length;

  function openDetails(position: TrackedPosition, opener: HTMLElement) {
    tradeCycleDrawer.closeCycle();
    setDetailOpener(opener);
    setDetailId(position.id);
  }

  function toggleInlineDetails(position: TrackedPosition) {
    tradeCycleDrawer.closeCycle();
    setExpandedId((current) => current === position.id ? null : position.id);
  }

  function openLifecycle(position: TrackedPosition) {
    setDetailId(null);
    setExpandedId(null);
    tradeCycleDrawer.openCycle(position.id);
  }

  function closeDetails() {
    const opener = detailOpener;
    setDetailId(null);
    window.setTimeout(() => opener?.focus(), 0);
  }

  function closePosition(position: TrackedPosition) {
    if (closeMutation.isPending) return;
    modals.openConfirmModal({
      title: "Close position",
      children: <Text size="sm">Submit a close order for <strong>{position.symbol}</strong> in <strong>{accountName(position)}</strong>?</Text>,
      labels: { confirm: "Close position", cancel: "Cancel" }, confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await closeMutation.mutateAsync(position.id);
          notifications.show({ message: `Close order submitted for ${position.symbol}.`, color: "teal" });
        } catch (error) {
          notifications.show({ message: error instanceof Error ? error.message : `Failed to close ${position.symbol}.`, color: "red" });
        }
      },
    });
  }

  const isClosing = (position: TrackedPosition) => closeMutation.isPending && closeMutation.variables === position.id;
  const lifecycleAction = (position: TrackedPosition) => ({ label: "View lifecycle", icon: <IconFileAnalytics size={16} />, onClick: () => openLifecycle(position) });
  const closeAction = (position: TrackedPosition) => ({ label: isClosing(position) ? "Closing position" : `Close ${position.symbol} position`, icon: <IconTrash size={16} />, color: "red", disabled: closeMutation.isPending, onClick: () => closePosition(position) });
  const actions = (position: TrackedPosition, compact = false) => <ResponsiveActions compact={compact} primary={lifecycleAction(position)} secondary={[closeAction(position)]} />;
  const details = (position: TrackedPosition, includeIdentity = false) => <div className={classes.detailComposition}>
    {includeIdentity && <div className={classes.drawerIdentity}>{identity(position)}{statusGroup(position)}</div>}
    <div className={classes.detailCards}>
      <section className={classes.detailCard} aria-labelledby={`position-${position.id}-position-heading`}>
        <Title id={`position-${position.id}-position-heading`} order={3} size="h5" className={classes.detailHeading}>Position</Title>
        <RecordDetailsGrid missingValue={MISSING_VALUE} sections={[{ items: [
          { label: "Average entry", value: formatCurrency(position.avgEntryPrice) }, { label: "Current price", value: formatCurrency(position.currentPrice) },
          { label: "Unrealized P/L", value: <ProfitLoss dollars={position.unrealizedPnL} ratio={position.unrealizedPnLPct} /> },
          { label: "Opened", value: formatDate(position.openedAt) }, { label: "Last synchronized", value: formatDate(position.lastSyncedAt) },
          { label: "Attention state", value: attentionMessage(position) },
        ] }]} />
      </section>
      <section className={`${classes.detailCard} ${classes.exitCard}`} aria-labelledby={`position-${position.id}-exit-heading`}>
        <div className={classes.exitHeading}><Title id={`position-${position.id}-exit-heading`} order={3} size="h5" className={classes.detailHeading}>Exit management</Title><StatusBadge status={conciseExitState(position)} label={conciseExitState(position)} tone={exitTone(position)} size="compact" /></div>
        <RecordDetailsGrid missingValue={MISSING_VALUE} sections={[{ items: [
          { label: "Exit strategy", value: exitStrategy(position) },
          { label: "Target", value: `${formatPercent(targetPercent(position))} · ${formatCurrency(targetPrice(position))}` },
          { label: "Trail percentage", value: unlockTrailing(position) ? formatPercent(position.trailingStopTrailPercent) : MISSING_VALUE },
          { label: "High-water mark", value: unlockTrailing(position) ? formatCurrency(position.trailingStopHwm) : MISSING_VALUE },
          { label: "Stop price", value: unlockTrailing(position) ? formatCurrency(position.trailingStopStopPrice) : MISSING_VALUE },
        ] }]} />
      </section>
    </div>
    <Accordion variant="contained" radius="md" className={classes.routingDisclosure}>
      <Accordion.Item value="routing"><Accordion.Control><div><Text fw={700} size="sm">Routing &amp; identifiers</Text><Text size="xs" c="dimmed" className={classes.routingSummary}>{position.subscription?.key ?? MISSING_VALUE}</Text></div></Accordion.Control><Accordion.Panel><RecordDetailsGrid missingValue={MISSING_VALUE} sections={[{ items: [
        { label: "Subscription", value: position.subscription?.key, technical: true }, { label: "Position ID", value: position.id, technical: true },
        { label: "Subscription ID", value: position.subscriptionId, technical: true }, { label: "Trading account ID", value: position.tradingAccountId, technical: true },
      ] }]} /></Accordion.Panel></Accordion.Item>
    </Accordion>
    <footer className={classes.detailActions}><Text fw={700} size="sm">Position actions</Text>{actions(position)}</footer>
  </div>;
  const identity = (position: TrackedPosition) => <div className={classes.identity}><Text component="h3" fw={800} size="md">{position.symbol}</Text><Text size="xs" c="dimmed" className={classes.wrap}>{accountName(position)}</Text><Text size="xs" c="dimmed">{titleCase(position.side)} · {position.qty} {position.qty === 1 ? "share" : "shares"}</Text></div>;
  const summaryFields = (position: TrackedPosition): SummaryField[] => [
    { label: "Current", value: formatCurrency(position.currentPrice) },
    { label: "P/L", value: <ProfitLoss dollars={position.unrealizedPnL} ratio={position.unrealizedPnLPct} /> },
  ];
  const statusGroup = (position: TrackedPosition) => <Group gap="xs" wrap="wrap" className={classes.badges}>
    <StatusBadge status={isClosing(position) ? "CLOSING" : position.status} tone={statusTone(position, isClosing(position))} size="compact" />
    <StatusBadge status={conciseExitState(position)} label={conciseExitState(position)} tone={exitTone(position)} size="compact" />
    {needsAttention(position) && conciseExitState(position) !== "Attention required" && <StatusBadge status="ATTENTION_REQUIRED" label="Attention required" tone="danger" size="compact" />}
  </Group>;

  const wide = (items: readonly TrackedPosition[]) => <DataTable caption="Open tracked positions" captionHidden density="compact"><Table.Thead><Table.Tr>
    <Table.Th>Position</Table.Th><Table.Th>Side / quantity</Table.Th><Table.Th className={classes.numeric}>Current</Table.Th><Table.Th className={classes.numeric}>P/L</Table.Th><Table.Th>Status / exit state</Table.Th><Table.Th className={classes.actionsHeading}>Actions</Table.Th>
  </Table.Tr></Table.Thead><Table.Tbody>{items.map((position) => <Fragment key={position.id}><Table.Tr>
    <Table.Td>{identity(position)}</Table.Td><Table.Td>{titleCase(position.side)} · {position.qty} {position.qty === 1 ? "share" : "shares"}</Table.Td>
    <Table.Td className={classes.numeric}>{formatCurrency(position.currentPrice)}</Table.Td><Table.Td className={classes.numeric}><ProfitLoss dollars={position.unrealizedPnL} ratio={position.unrealizedPnLPct} /></Table.Td>
    <Table.Td>{statusGroup(position)}</Table.Td><Table.Td><Group justify="flex-end" wrap="nowrap"><Button variant="default" size="compact-sm" onClick={() => toggleInlineDetails(position)} aria-expanded={expandedId === position.id} aria-controls={`position-${position.id}-wide-details`} rightSection={expandedId === position.id ? <IconChevronUp size={15} aria-hidden="true" /> : <IconChevronDown size={15} aria-hidden="true" />}>Details</Button><ResponsiveActions compact secondary={[lifecycleAction(position), closeAction(position)]} /></Group></Table.Td>
  </Table.Tr>{expandedId === position.id && <Table.Tr><Table.Td colSpan={6} id={`position-${position.id}-wide-details`} className={classes.inlineDetails}>{details(position)}</Table.Td></Table.Tr>}</Fragment>)}</Table.Tbody></DataTable>;
  const compact = (items: readonly TrackedPosition[]) => <CompactRecordList records={items} getRecordId={(position) => position.id} renderIdentity={(position) => <Stack gap="xs">{identity(position)}{statusGroup(position)}</Stack>} renderFields={summaryFields} renderDetails={details} renderActions={(position) => <ResponsiveActions compact secondary={[lifecycleAction(position), closeAction(position)]} />} expandedId={expandedId} onExpandedChange={(id) => { if (id !== null) tradeCycleDrawer.closeCycle(); setExpandedId(id); }} />;
  const narrow = (items: readonly TrackedPosition[]) => <MobileRecordCard records={items} getRecordId={(position) => position.id} renderIdentity={identity} renderStatus={statusGroup} renderFields={summaryFields} onDetails={openDetails} renderActions={(position) => <ResponsiveActions compact primary={lifecycleAction(position)} secondary={[closeAction(position)]} />} />;

  return <main className={classes.page}><Stack gap="lg">
    <Group justify="space-between" align="flex-end" gap="md"><div><Title order={2} size="h3">Open Positions</Title><Text size="sm" c="dimmed">Live tracked positions and exit management.</Text></div>{!positionsQuery.isLoading && !positionsQuery.isError && <Text size="sm" c="dimmed">{positions.length} open {positions.length === 1 ? "position" : "positions"}{attentionCount > 0 ? ` · ${attentionCount} requiring attention` : ""}</Text>}</Group>
    <Card withBorder radius="md" p="md" className={classes.panel}>
      {positionsQuery.isLoading ? <DataState state="loading" message="Loading open positions…" /> : positionsQuery.isError ? <DataState state="error" title="Unable to load open positions" message={positionsQuery.error instanceof Error ? positionsQuery.error.message : "Open positions could not be loaded."} onRetry={() => void positionsQuery.refetch()} /> : positions.length === 0 ? <DataState state="empty" title="No open positions" message="Positions will appear here after entry orders fill." /> : <ResponsiveDataView records={positions} getRecordId={(position) => position.id} wide={wide} compact={compact} narrow={narrow} aria-label="Open positions" />}
    </Card>
  </Stack>
  {detailPosition ? <ResponsiveDetails opened title={`${detailPosition.symbol} position details`} onClose={closeDetails}>{details(detailPosition, true)}</ResponsiveDetails> : <TradeCycleDrawer {...tradeCycleDrawer.drawerProps} onClose={tradeCycleDrawer.closeCycle} />}
  </main>;
}
